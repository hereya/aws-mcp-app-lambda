"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.HereyaAwsMcpAppLambdaStack = void 0;
const cdk = __importStar(require("aws-cdk-lib/core"));
const core_1 = require("aws-cdk-lib/core");
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const apigwv2 = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const integrations = __importStar(require("aws-cdk-lib/aws-apigatewayv2-integrations"));
const secrets = __importStar(require("aws-cdk-lib/aws-secretsmanager"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const targets = __importStar(require("aws-cdk-lib/aws-route53-targets"));
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const authorizers = __importStar(require("aws-cdk-lib/aws-apigatewayv2-authorizers"));
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const origins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const path = __importStar(require("path"));
class HereyaAwsMcpAppLambdaStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const hereyaProjectRootDir = process.env["hereyaProjectRootDir"];
        if (!hereyaProjectRootDir) {
            throw new Error("hereyaProjectRootDir environment variable is required");
        }
        const oauthServerUrl = process.env["oauthServerUrl"];
        if (!oauthServerUrl) {
            throw new Error("oauthServerUrl environment variable is required");
        }
        const organizationId = process.env["organizationId"];
        if (!organizationId) {
            throw new Error("organizationId environment variable is required");
        }
        const memorySize = process.env["memorySize"]
            ? parseInt(process.env["memorySize"])
            : 256;
        const timeout = process.env["timeout"]
            ? parseInt(process.env["timeout"])
            : 30;
        const handlerName = process.env["handler"] ?? "handler.handler";
        const customDomain = process.env["customDomain"];
        const customDomainZone = process.env["customDomainZone"] ?? extractDomainZone(customDomain);
        const wildcardCertificateArn = process.env["wildcardCertificateArn"];
        // Extra request headers the frontend CloudFront distribution should forward to
        // origin (comma-separated). CloudFront strips any header not whitelisted, so
        // custom auth/webhook headers must be listed here. NOTE: `Authorization` CANNOT
        // be added to an OriginRequestPolicy (AWS only allows it via a cache policy) —
        // use a custom header name instead (e.g. X-Dilaya-Agent-Token for the agent poll).
        const additionalForwardedHeaders = (process.env["additionalForwardedHeaders"] ?? "")
            .split(",")
            .map((h) => h.trim())
            .filter(Boolean);
        const frontendForwardHeaders = [
            "Content-Type",
            "Accept-Language",
            "x-forwarded-host",
            "X-Telegram-Bot-Api-Secret-Token",
            ...additionalForwardedHeaders,
        ].filter((h, i, a) => a.findIndex((x) => x.toLowerCase() === h.toLowerCase()) === i);
        // Parse hereyaProjectEnv
        const env = JSON.parse(process.env["hereyaProjectEnv"] ?? "{}");
        // Separate IAM policy env vars
        const policyEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("IAM_POLICY_") || key.startsWith("iamPolicy")));
        const nonPolicyEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("IAM_POLICY_") && !key.startsWith("iamPolicy")));
        // Separate secret env vars (secret:// prefix)
        const secretEnvEntries = Object.entries(nonPolicyEnv)
            .filter(([, value]) => value.startsWith("secret://"))
            .map(([key, value]) => {
            const plainValue = value.split("secret://")[1];
            const secretName = `/${this.stackName}/${key}`;
            const secret = new secrets.Secret(this, key, {
                secretName,
                secretStringValue: core_1.SecretValue.unsafePlainText(plainValue),
            });
            return { key, secret, secretName };
        });
        const plainEnv = Object.fromEntries(Object.entries(nonPolicyEnv).filter(([, value]) => !value.startsWith("secret://")));
        // Cognito config (from aws/cognito package outputs via hereyaProjectEnv)
        const cognitoUserPoolId = plainEnv["userPoolId"] ?? nonPolicyEnv["userPoolId"];
        const cognitoClientId = plainEnv["userPoolClientId"] ?? nonPolicyEnv["userPoolClientId"];
        const cognitoRegion = plainEnv["awsCognitoRegion"] ?? nonPolicyEnv["awsCognitoRegion"] ?? process.env["CDK_DEFAULT_REGION"] ?? "us-east-1";
        // -----------------------------------------------------------------------
        // Lambda naming prefix for per-app Lambdas (derived from customDomain)
        // -----------------------------------------------------------------------
        const orgPrefix = customDomain
            ? customDomain.split(".")[0]
            : this.stackName.substring(0, 20);
        const appLambdaNamePrefix = `${orgPrefix}-app-`;
        // -----------------------------------------------------------------------
        // Lambda 1: App Handler (Org Lambda — MCP only)
        // -----------------------------------------------------------------------
        // Pass deploy-time config vars to the handler (not in hereyaProjectEnv)
        if (customDomain) {
            plainEnv["customDomain"] = customDomain;
        }
        const fn = new lambda.Function(this, "Handler", {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: handlerName,
            code: lambda.Code.fromAsset(path.join(hereyaProjectRootDir, "dist")),
            memorySize,
            timeout: cdk.Duration.seconds(timeout),
            environment: plainEnv,
        });
        // Attach secret references (secret name, not value) and grant read access
        const secretKeys = [];
        for (const { key, secret, secretName } of secretEnvEntries) {
            fn.addEnvironment(key, secretName);
            secret.grantRead(fn);
            secretKeys.push(key);
        }
        if (secretKeys.length > 0) {
            fn.addEnvironment("SECRET_KEYS", secretKeys.join(","));
        }
        // Attach IAM policies from dependency packages
        for (const [, value] of Object.entries(policyEnv)) {
            const policy = JSON.parse(value);
            for (const statement of policy.Statement) {
                fn.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
            }
        }
        // -----------------------------------------------------------------------
        // Shared IAM Role for per-app Lambdas
        // -----------------------------------------------------------------------
        const appLambdaRole = new iam.Role(this, "AppLambdaRole", {
            assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
            managedPolicies: [
                iam.ManagedPolicy.fromManagedPolicyArn(this, "AppLambdaBasicExec", "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"),
            ],
        });
        // Apply same IAM policies from dependency packages (Aurora, S3, etc.)
        for (const [, value] of Object.entries(policyEnv)) {
            const policy = JSON.parse(value);
            for (const statement of policy.Statement) {
                appLambdaRole.addToPolicy(iam.PolicyStatement.fromJson(statement));
            }
        }
        // -----------------------------------------------------------------------
        // Lambda Layer for per-app runtime utilities
        // -----------------------------------------------------------------------
        const runtimeLayer = new lambda.LayerVersion(this, "AppRuntimeLayer", {
            code: lambda.Code.fromAsset(path.join(hereyaProjectRootDir, "dist", "layer")),
            compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
            description: "Hereya runtime (db, storage) for per-app Lambdas",
        });
        // -----------------------------------------------------------------------
        // Per-app auth: shared multi-tenant Cognito triggers + OTP table.
        //
        // `enable-auth` provisions a dedicated Cognito user pool per app. All
        // pools across the org are wired to the same 4 challenge trigger Lambdas
        // declared here — the triggers are pool-agnostic (they read
        // event.userPoolId at runtime). The OTP table is keyed by
        // (pool_id, email) so concurrent logins across pools can't collide.
        // -----------------------------------------------------------------------
        const otpTable = new dynamodb.Table(this, "AppAuthOtpTable", {
            partitionKey: {
                name: "pool_id",
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: { name: "email", type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: "ttl",
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        const triggerEnv = { OTP_TABLE_NAME: otpTable.tableName };
        const makeTrigger = (id, dir) => new lambda.Function(this, id, {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "cognito-triggers", dir)),
            memorySize: 128,
            timeout: cdk.Duration.seconds(10),
            environment: triggerEnv,
        });
        const preSignUpFn = makeTrigger("PreSignUpTrigger", "pre-sign-up");
        const defineChallengeFn = makeTrigger("DefineAuthChallengeTrigger", "define-auth-challenge");
        const createChallengeFn = makeTrigger("CreateAuthChallengeTrigger", "create-auth-challenge");
        const verifyChallengeFn = makeTrigger("VerifyAuthChallengeTrigger", "verify-auth-challenge");
        otpTable.grantReadWriteData(createChallengeFn);
        otpTable.grantReadWriteData(verifyChallengeFn);
        // Verify trigger also updates the Cognito user attribute `email_verified`.
        // Scoping to resource="*" because per-app pools are created at runtime by
        // the org Lambda — we can't pin a single ARN at stack deploy time.
        verifyChallengeFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ["cognito-idp:AdminUpdateUserAttributes"],
            resources: ["*"],
        }));
        const triggerArns = [
            preSignUpFn.functionArn,
            defineChallengeFn.functionArn,
            createChallengeFn.functionArn,
            verifyChallengeFn.functionArn,
        ];
        // -----------------------------------------------------------------------
        // MCP OAuth Authorizer Lambda
        // -----------------------------------------------------------------------
        const authorizerFn = new lambda.Function(this, "AuthorizerHandler", {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "authorizer")),
            memorySize: 128,
            timeout: cdk.Duration.seconds(10),
            environment: {
                OAUTH_SERVER_URL: oauthServerUrl,
                BOUND_ORG_ID: organizationId,
            },
        });
        const httpAuthorizer = new authorizers.HttpLambdaAuthorizer("HereyaAuthorizer", authorizerFn, {
            responseTypes: [authorizers.HttpLambdaResponseType.SIMPLE],
            resultsCacheTtl: cdk.Duration.minutes(5),
        });
        // -----------------------------------------------------------------------
        // HTTP API
        // -----------------------------------------------------------------------
        const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
            apiName: this.stackName,
        });
        const lambdaIntegration = new integrations.HttpLambdaIntegration("LambdaIntegration", fn);
        // Compute service URL for PRM (custom domain or API endpoint)
        const serviceUrl = customDomain
            ? `https://${customDomain}`
            : httpApi.apiEndpoint;
        // -----------------------------------------------------------------------
        // Protected Resource Metadata (RFC 9728)
        // -----------------------------------------------------------------------
        const prmLambda = new lambda.Function(this, "PrmHandler", {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: "index.handler",
            code: lambda.Code.fromInline(`
        exports.handler = async () => ({
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({
            resource: process.env.SERVICE_URL + "/mcp",
            authorization_servers: [process.env.OAUTH_SERVER_URL + "/oauth/" + process.env.ORGANIZATION_ID],
            bearer_methods_supported: ["header"],
            scopes_supported: ["mcp:access"],
          }),
        });
      `),
            memorySize: 128,
            timeout: cdk.Duration.seconds(5),
            environment: {
                SERVICE_URL: serviceUrl,
                OAUTH_SERVER_URL: oauthServerUrl,
                ORGANIZATION_ID: organizationId,
            },
        });
        httpApi.addRoutes({
            path: "/.well-known/oauth-protected-resource",
            methods: [apigwv2.HttpMethod.GET],
            integration: new integrations.HttpLambdaIntegration("PrmIntegration", prmLambda),
        });
        // MCP route (existing)
        httpApi.addRoutes({
            path: "/mcp",
            methods: [apigwv2.HttpMethod.POST],
            integration: lambdaIntegration,
            authorizer: httpAuthorizer,
        });
        // Allow API Gateway to invoke the org Lambda on ANY route of this API.
        // HttpLambdaIntegration only grants a route-specific permission for /mcp,
        // but the org Lambda creates additional routes at runtime that target
        // itself (e.g. per-app Telegram webhooks at /{schema}/telegram/{proxy+}).
        // Without an api-scoped permission those routes return 500 (API Gateway
        // cannot invoke the Lambda), and the org Lambda cannot self-grant
        // (its lambda:AddPermission IAM is scoped to per-app function names only).
        fn.addPermission("HttpApiInvokeAll", {
            principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
            sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${httpApi.apiId}/*/*`,
        });
        // -----------------------------------------------------------------------
        // Frontend Authorizer + Auth Lambda (for per-app Lambdas)
        // -----------------------------------------------------------------------
        // These are created at CDK time. Their IDs are passed to the org Lambda
        // so it can create per-app API Gateway routes dynamically.
        let frontendAuthorizerId;
        let authIntegrationId;
        if (cognitoUserPoolId && cognitoClientId) {
            // Frontend Authorizer Lambda (multi-tenant: per-app pool lookup via DB,
            // with shared-pool fallback for Phase-A migration).
            const frontendAuthorizerFn = new lambda.Function(this, "FrontendAuthorizerHandler", {
                runtime: lambda.Runtime.NODEJS_22_X,
                handler: "index.handler",
                code: lambda.Code.fromAsset(path.join(__dirname, "frontend-authorizer")),
                memorySize: 128,
                timeout: cdk.Duration.seconds(10),
                environment: {
                    COGNITO_USER_POOL_ID: cognitoUserPoolId,
                    COGNITO_REGION: cognitoRegion,
                    clusterArn: plainEnv["clusterArn"] ?? "",
                    secretArn: plainEnv["secretArn"] ?? "",
                    databaseName: plainEnv["databaseName"] ?? "",
                },
            });
            // Apply Aurora Data API policies from dep packages so the authorizer can
            // SELECT from public._app_auth.
            for (const [, value] of Object.entries(policyEnv)) {
                const policy = JSON.parse(value);
                for (const statement of policy.Statement) {
                    frontendAuthorizerFn.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
                }
            }
            // Grant API Gateway permission to invoke the frontend authorizer
            frontendAuthorizerFn.addPermission("ApiGwAuthorizerInvoke", {
                principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
                sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${httpApi.apiId}/*`,
            });
            // Frontend Authorizer as L1 construct (to get authorizer ID)
            const frontendAuthorizerCfn = new apigwv2.CfnAuthorizer(this, "FrontendAuthorizerCfn", {
                apiId: httpApi.apiId,
                authorizerType: "REQUEST",
                authorizerUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${frontendAuthorizerFn.functionArn}/invocations`,
                authorizerPayloadFormatVersion: "2.0",
                enableSimpleResponses: true,
                authorizerResultTtlInSeconds: 0,
                identitySource: [], // empty = always invoke (supports public endpoints)
                name: "FrontendAuthorizerV2",
            });
            frontendAuthorizerId = frontendAuthorizerCfn.ref;
            // Auth Lambda (login/OTP/verify/logout). Multi-tenant: extracts app from
            // path, looks up per-app pool client + Postmark token, falls back to the
            // shared org pool for unmigrated apps.
            const authLambdaEnv = {
                COGNITO_USER_POOL_ID: cognitoUserPoolId,
                COGNITO_CLIENT_ID: cognitoClientId,
                COGNITO_REGION: cognitoRegion,
                CUSTOM_DOMAIN: customDomain ?? "",
                BUCKET_NAME: plainEnv["bucketName"] ?? "",
                S3_PREFIX: plainEnv["s3Prefix"] ?? "",
                ORGANIZATION_ID: organizationId,
                clusterArn: plainEnv["clusterArn"] ?? "",
                secretArn: plainEnv["secretArn"] ?? "",
                databaseName: plainEnv["databaseName"] ?? "",
            };
            const authLambdaFn = new lambda.Function(this, "AuthLambdaHandler", {
                runtime: lambda.Runtime.NODEJS_22_X,
                handler: "index.handler",
                code: lambda.Code.fromAsset(path.join(__dirname, "auth-lambda")),
                memorySize: 128,
                timeout: cdk.Duration.seconds(15),
                environment: authLambdaEnv,
            });
            // Grant Auth Lambda access to secrets
            const authSecretKeys = [];
            for (const { key, secret, secretName } of secretEnvEntries) {
                authLambdaFn.addEnvironment(key, secretName);
                secret.grantRead(authLambdaFn);
                authSecretKeys.push(key);
            }
            if (authSecretKeys.length > 0) {
                authLambdaFn.addEnvironment("SECRET_KEYS", authSecretKeys.join(","));
            }
            // Grant Auth Lambda Cognito permissions + Data API (to read _app_auth).
            for (const [, value] of Object.entries(policyEnv)) {
                const policy = JSON.parse(value);
                for (const statement of policy.Statement) {
                    authLambdaFn.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
                }
            }
            // Read per-app Postmark server token from SSM SecureString.
            const appAuthSsmArn = `arn:aws:ssm:${this.region}:${this.account}:parameter/hereya/${organizationId}/apps/*`;
            authLambdaFn.addToRolePolicy(new iam.PolicyStatement({
                actions: ["ssm:GetParameter"],
                resources: [appAuthSsmArn],
            }));
            authLambdaFn.addToRolePolicy(new iam.PolicyStatement({
                actions: ["kms:Decrypt"],
                resources: ["*"],
                conditions: {
                    StringEquals: {
                        "kms:ViaService": `ssm.${this.region}.amazonaws.com`,
                    },
                },
            }));
            // Allow InitiateAuth / RespondToAuthChallenge against any per-app pool
            // in this account (pool ARNs are created at runtime by enable-auth).
            authLambdaFn.addToRolePolicy(new iam.PolicyStatement({
                actions: [
                    "cognito-idp:InitiateAuth",
                    "cognito-idp:RespondToAuthChallenge",
                ],
                resources: ["*"],
            }));
            // Grant API Gateway permission to invoke auth Lambda
            authLambdaFn.addPermission("ApiGwInvoke", {
                principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
                sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${httpApi.apiId}/*/*`,
            });
            // Auth Lambda integration as L1 construct (to get integration ID)
            const authIntegrationCfn = new apigwv2.CfnIntegration(this, "AuthIntegrationCfn", {
                apiId: httpApi.apiId,
                integrationType: "AWS_PROXY",
                integrationUri: authLambdaFn.functionArn,
                payloadFormatVersion: "2.0",
            });
            authIntegrationId = authIntegrationCfn.ref;
        }
        // -----------------------------------------------------------------------
        // Org Lambda: per-app Lambda management permissions
        // -----------------------------------------------------------------------
        const appLambdaArnPattern = `arn:aws:lambda:${this.region}:${this.account}:function:${appLambdaNamePrefix}*`;
        fn.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                "lambda:CreateFunction",
                "lambda:UpdateFunctionCode",
                "lambda:UpdateFunctionConfiguration",
                "lambda:GetFunction",
                "lambda:DeleteFunction",
                "lambda:AddPermission",
                "lambda:RemovePermission",
                "lambda:InvokeFunction",
            ],
            resources: [appLambdaArnPattern],
        }));
        // Lambda layer access (needed when creating per-app Lambdas with layers)
        fn.addToRolePolicy(new iam.PolicyStatement({
            actions: ["lambda:GetLayerVersion"],
            resources: [runtimeLayer.layerVersionArn],
        }));
        // API Gateway route management
        fn.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                "apigateway:POST",
                "apigateway:DELETE",
                "apigateway:GET",
                "apigateway:PATCH",
            ],
            resources: [
                `arn:aws:apigateway:${this.region}::/apis/${httpApi.apiId}/*`,
            ],
        }));
        // Pass shared role to per-app Lambdas
        fn.addToRolePolicy(new iam.PolicyStatement({
            actions: ["iam:PassRole"],
            resources: [appLambdaRole.roleArn],
        }));
        // -----------------------------------------------------------------------
        // SSM SecureString for per-app agent-session signing secrets.
        // Prefix-bound to /hereya/{organizationId}/apps/* so the org Lambda and
        // per-app Lambdas can only touch their own org's secrets.
        // -----------------------------------------------------------------------
        const agentSecretSsmArn = `arn:aws:ssm:${this.region}:${this.account}:parameter/hereya/${organizationId}/apps/*`;
        fn.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                "ssm:GetParameter",
                "ssm:GetParameters",
                "ssm:PutParameter",
                "ssm:DeleteParameter",
            ],
            resources: [agentSecretSsmArn],
        }));
        appLambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ["ssm:GetParameter"],
            resources: [agentSecretSsmArn],
        }));
        // KMS decrypt for the AWS-managed SSM key (SecureString).
        // Scoped via ViaService condition so it only works through SSM.
        const ssmKmsDecrypt = new iam.PolicyStatement({
            actions: ["kms:Decrypt"],
            resources: ["*"],
            conditions: {
                StringEquals: {
                    "kms:ViaService": `ssm.${this.region}.amazonaws.com`,
                },
            },
        });
        fn.addToRolePolicy(ssmKmsDecrypt);
        appLambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ["kms:Decrypt"],
            resources: ["*"],
            conditions: {
                StringEquals: {
                    "kms:ViaService": `ssm.${this.region}.amazonaws.com`,
                },
            },
        }));
        // Per-app Lambdas may opt in to registering users server-side via the
        // hereya runtime's users.addUser helper. Since per-app Cognito pools are
        // locked to AllowAdminCreateUserOnly=true, the helper calls
        // AdminCreateUser. Scope by the HereyaOrg tag on the pool so one org's
        // per-app Lambdas cannot create users in another org's pools.
        appLambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ["cognito-idp:AdminCreateUser"],
            resources: ["*"],
            conditions: {
                StringEquals: {
                    "aws:ResourceTag/HereyaOrg": organizationId,
                },
            },
        }));
        // -----------------------------------------------------------------------
        // Org Lambda: environment variables for per-app Lambda management
        // -----------------------------------------------------------------------
        fn.addEnvironment("APP_LAMBDA_ROLE_ARN", appLambdaRole.roleArn);
        fn.addEnvironment("APP_LAMBDA_NAME_PREFIX", appLambdaNamePrefix);
        fn.addEnvironment("APP_LAMBDA_LAYER_ARN", runtimeLayer.layerVersionArn);
        fn.addEnvironment("HTTP_API_ID", httpApi.apiId);
        fn.addEnvironment("AWS_ACCOUNT_ID", this.account);
        fn.addEnvironment("ORGANIZATION_ID", organizationId);
        fn.addEnvironment("AGENT_SECRET_SSM_PREFIX", `/hereya/${organizationId}/apps`);
        fn.addEnvironment("COGNITO_TRIGGER_LAMBDA_ARNS", triggerArns.join(","));
        fn.addEnvironment("awsRegion", this.region);
        if (frontendAuthorizerId) {
            fn.addEnvironment("FRONTEND_AUTHORIZER_ID", frontendAuthorizerId);
        }
        if (authIntegrationId) {
            fn.addEnvironment("AUTH_INTEGRATION_ID", authIntegrationId);
        }
        // -----------------------------------------------------------------------
        // Per-app lightweight state table (DynamoDB, on-demand). Used for cheap
        // "is there something new?" flags so polling loops don't have to query
        // Aurora (which would keep it from scaling to zero). Org-scoped (one table
        // per deployment); items are keyed per app via the partition key.
        // -----------------------------------------------------------------------
        const appStateTable = new dynamodb.Table(this, "AppStateTable", {
            partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        fn.addEnvironment("APP_STATE_TABLE", appStateTable.tableName);
        appStateTable.grantReadWriteData(fn);
        // -----------------------------------------------------------------------
        // Org Lambda: per-app auth provisioning permissions (enable-auth tool).
        //
        // Per-app Cognito pools + clients are created at runtime (resources are
        // only known after CreateUserPool succeeds), so resource="*". The org
        // Lambda needs to attach the shared trigger Lambdas to each new pool
        // (AddPermission) and clean them up on drop-schema (RemovePermission).
        // -----------------------------------------------------------------------
        fn.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                "cognito-idp:CreateUserPool",
                "cognito-idp:DeleteUserPool",
                "cognito-idp:UpdateUserPool",
                "cognito-idp:DescribeUserPool",
                "cognito-idp:ListUserPools",
                "cognito-idp:CreateUserPoolClient",
                "cognito-idp:DeleteUserPoolClient",
                "cognito-idp:UpdateUserPoolClient",
                "cognito-idp:DescribeUserPoolClient",
                "cognito-idp:AdminCreateUser",
                "cognito-idp:ListUsers",
                "cognito-idp:TagResource",
            ],
            resources: ["*"],
        }));
        fn.addToRolePolicy(new iam.PolicyStatement({
            actions: ["lambda:AddPermission", "lambda:RemovePermission"],
            resources: triggerArns,
        }));
        // -----------------------------------------------------------------------
        // Custom domain + DNS
        // -----------------------------------------------------------------------
        if (customDomain && customDomainZone) {
            if (!wildcardCertificateArn) {
                throw new Error("wildcardCertificateArn is required when customDomain is set");
            }
            const certificate = acm.Certificate.fromCertificateArn(this, "Certificate", wildcardCertificateArn);
            const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
                domainName: customDomainZone,
            });
            // Expose hosted zone ID + grant Route53 record-set management so the
            // org Lambda can write DKIM + return-path records when provisioning
            // per-app Postmark domains via enable-auth.
            fn.addEnvironment("HOSTED_ZONE_ID", hostedZone.hostedZoneId);
            fn.addToRolePolicy(new iam.PolicyStatement({
                actions: [
                    "route53:ChangeResourceRecordSets",
                    "route53:ListResourceRecordSets",
                    "route53:GetHostedZone",
                ],
                resources: [
                    `arn:aws:route53:::hostedzone/${hostedZone.hostedZoneId}`,
                ],
            }));
            // API Gateway custom domain for MCP (exact domain)
            const domainName = new apigwv2.DomainName(this, "DomainName", {
                domainName: customDomain,
                certificate,
            });
            new apigwv2.ApiMapping(this, "ApiMapping", {
                api: httpApi,
                domainName,
            });
            new route53.ARecord(this, "AliasRecord", {
                zone: hostedZone,
                recordName: customDomain,
                target: route53.RecordTarget.fromAlias(new targets.ApiGatewayv2DomainProperties(domainName.regionalDomainName, domainName.regionalHostedZoneId)),
            });
            // -------------------------------------------------------------------
            // CloudFront distribution for frontend (*.{customDomain})
            // -------------------------------------------------------------------
            if (cognitoUserPoolId && cognitoClientId) {
                const cloudfrontCertificate = new acm.DnsValidatedCertificate(this, "CloudFrontCertificate", {
                    domainName: `*.${customDomain}`,
                    hostedZone,
                    region: "us-east-1",
                });
                // CloudFront Function: extract app subdomain → prepend to path, and
                // (when the org Lambda regenerates the code) route custom vanity
                // domains via a per-host domainMap lookup.
                //
                // This inline code is the BOOTSTRAP version with an empty domainMap.
                // On the first `set-custom-domains`/`check-custom-domains` cycle the
                // org Lambda overwrites this function with a regenerated version that
                // contains the active domain→schema mapping. The shape must match
                // src/custom-domain-template.ts in the hereya-apps repo so runtime
                // updates are drop-in replacements.
                const cfFunction = new cloudfront.Function(this, "SubdomainRewrite", {
                    code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var host = request.headers.host.value;
  var customDomain = ${JSON.stringify(customDomain)};
  var domainMap = {};
  if (domainMap[host]) {
    request.uri = '/' + domainMap[host] + request.uri;
    return request;
  }
  if (host !== customDomain && host.endsWith('.' + customDomain)) {
    var appName = host.slice(0, -(customDomain.length + 1));
    request.uri = '/' + appName + request.uri;
  }
  return request;
}
          `),
                    functionName: `${this.stackName}-subdomain-rewrite`,
                });
                // API Gateway origin
                const apiDomainName = cdk.Fn.select(2, cdk.Fn.split("/", httpApi.apiEndpoint));
                const distribution = new cloudfront.Distribution(this, "FrontendDistribution", {
                    certificate: cloudfrontCertificate,
                    domainNames: [`*.${customDomain}`],
                    defaultBehavior: {
                        origin: new origins.HttpOrigin(apiDomainName, {
                            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
                        }),
                        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                        originRequestPolicy: new cloudfront.OriginRequestPolicy(this, "FrontendOriginPolicy", {
                            cookieBehavior: cloudfront.OriginRequestCookieBehavior.allowList("hereya_id_token", "hereya_agent"),
                            // Base set + `additionalForwardedHeaders` (built at the top of
                            // the constructor). CloudFront strips any header not whitelisted
                            // here, so custom auth/webhook headers (x-forwarded-host for
                            // vanity-host login cookies; X-Telegram-Bot-Api-Secret-Token for
                            // the Telegram webhook; X-Dilaya-Agent-Token for the agent poll)
                            // must appear in this list or the origin never sees them.
                            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...frontendForwardHeaders),
                            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
                        }),
                        functionAssociations: [
                            {
                                function: cfFunction,
                                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                            },
                        ],
                    },
                });
                // Route53 wildcard -> CloudFront
                new route53.ARecord(this, "WildcardAliasRecord", {
                    zone: hostedZone,
                    recordName: `*.${customDomain}`,
                    target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
                });
                new cdk.CfnOutput(this, "FrontendDistributionDomain", {
                    value: distribution.distributionDomainName,
                });
                // -----------------------------------------------------------------
                // Custom-domain support wiring
                //
                // The org Lambda exposes MCP tools that swap the distribution's
                // ViewerCertificate in-place when users request vanity domains. We:
                //   1. Seed an SSM param with the bootstrap wildcard cert ARN on
                //      first deploy (onUpdate is a no-op → subsequent deploys don't
                //      overwrite the Lambda's live cert ARN).
                //   2. Grant the org Lambda ACM (tag-scoped) + CloudFront (ARN-scoped)
                //      + SSM (path-scoped) permissions.
                //   3. Pass distribution + function identifiers + SSM path through env.
                //
                // NOTE on drift: if a future CDK stack change touches the Distribution
                // or the CF function, CloudFormation will re-send CDK's inline config
                // and overwrite the Lambda's live state. Remediation is to re-run
                // `check-custom-domains` after the stack update.
                // -----------------------------------------------------------------
                const viewerCertSsmParamName = `/hereya/${organizationId}/viewer-cert-arn`;
                const viewerCertSsmParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${viewerCertSsmParamName}`;
                const seedViewerCertArn = new cr.AwsCustomResource(this, "ViewerCertSsmSeed", {
                    onCreate: {
                        service: "SSM",
                        action: "PutParameter",
                        parameters: {
                            Name: viewerCertSsmParamName,
                            Value: cloudfrontCertificate.certificateArn,
                            Type: "String",
                            Overwrite: false,
                        },
                        physicalResourceId: cr.PhysicalResourceId.of(`viewer-cert-seed-${organizationId}`),
                        ignoreErrorCodesMatching: "ParameterAlreadyExists",
                    },
                    onUpdate: {
                        service: "SSM",
                        action: "GetParameter",
                        parameters: { Name: viewerCertSsmParamName },
                        physicalResourceId: cr.PhysicalResourceId.of(`viewer-cert-seed-${organizationId}`),
                        ignoreErrorCodesMatching: "ParameterNotFound",
                    },
                    onDelete: {
                        service: "SSM",
                        action: "DeleteParameter",
                        parameters: { Name: viewerCertSsmParamName },
                        ignoreErrorCodesMatching: "ParameterNotFound",
                    },
                    policy: cr.AwsCustomResourcePolicy.fromStatements([
                        new iam.PolicyStatement({
                            actions: [
                                "ssm:PutParameter",
                                "ssm:GetParameter",
                                "ssm:DeleteParameter",
                            ],
                            resources: [viewerCertSsmParamArn],
                        }),
                    ]),
                    installLatestAwsSdk: false,
                });
                seedViewerCertArn.node.addDependency(cloudfrontCertificate);
                // --- ACM (tag-scoped): any cert the org Lambda creates must be
                //     tagged with its own orgId; all non-create actions are gated on
                //     the same tag matching on the resource. This prevents org A from
                //     touching org B's certs.
                fn.addToRolePolicy(new iam.PolicyStatement({
                    actions: [
                        "acm:RequestCertificate",
                        "acm:AddTagsToCertificate",
                    ],
                    resources: ["*"],
                    conditions: {
                        StringEquals: {
                            "aws:RequestTag/hereya:orgId": organizationId,
                        },
                        "ForAllValues:StringEquals": {
                            "aws:TagKeys": [
                                "hereya:orgId",
                                "hereya:schema",
                                "hereya:domains",
                            ],
                        },
                    },
                }));
                fn.addToRolePolicy(new iam.PolicyStatement({
                    actions: [
                        "acm:DescribeCertificate",
                        "acm:DeleteCertificate",
                        "acm:ListTagsForCertificate",
                    ],
                    resources: [
                        `arn:aws:acm:us-east-1:${this.account}:certificate/*`,
                    ],
                    conditions: {
                        StringEquals: {
                            "aws:ResourceTag/hereya:orgId": organizationId,
                        },
                    },
                }));
                // --- CloudFront (ARN-scoped): the org Lambda may only update ITS
                //     own distribution and function.
                fn.addToRolePolicy(new iam.PolicyStatement({
                    actions: [
                        "cloudfront:GetDistribution",
                        "cloudfront:GetDistributionConfig",
                        "cloudfront:UpdateDistribution",
                    ],
                    resources: [
                        `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
                    ],
                }));
                fn.addToRolePolicy(new iam.PolicyStatement({
                    actions: [
                        "cloudfront:GetFunction",
                        "cloudfront:DescribeFunction",
                        "cloudfront:UpdateFunction",
                        "cloudfront:PublishFunction",
                    ],
                    resources: [
                        `arn:aws:cloudfront::${this.account}:function/${cfFunction.functionName}`,
                    ],
                }));
                // --- SSM (path-scoped): write the cert ARN on swap.
                fn.addToRolePolicy(new iam.PolicyStatement({
                    actions: ["ssm:GetParameter", "ssm:PutParameter"],
                    resources: [viewerCertSsmParamArn],
                }));
                // --- Expose IDs to the org Lambda.
                fn.addEnvironment("CLOUDFRONT_DISTRIBUTION_ID", distribution.distributionId);
                fn.addEnvironment("CLOUDFRONT_FUNCTION_NAME", cfFunction.functionName);
                fn.addEnvironment("CLOUDFRONT_DOMAIN", distribution.distributionDomainName);
                fn.addEnvironment("VIEWER_CERT_SSM_PARAM", viewerCertSsmParamName);
                fn.node.addDependency(seedViewerCertArn);
            }
            new cdk.CfnOutput(this, "ServiceUrl", {
                value: `https://${customDomain}`,
            });
        }
        else {
            new cdk.CfnOutput(this, "ServiceUrl", {
                value: httpApi.apiEndpoint,
            });
        }
    }
}
exports.HereyaAwsMcpAppLambdaStack = HereyaAwsMcpAppLambdaStack;
function extractDomainZone(customDomain) {
    if (!customDomain)
        return undefined;
    const parts = customDomain.split(".");
    if (parts.length < 2)
        throw new Error("Invalid domain name: " + customDomain);
    return parts.length === 2 ? customDomain : parts.slice(1).join(".");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGVyZXlhLWF3cy1tY3AtYXBwLWxhbWJkYS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImhlcmV5YS1hd3MtbWNwLWFwcC1sYW1iZGEtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsc0RBQXdDO0FBQ3hDLDJDQUErQztBQUMvQywrREFBaUQ7QUFDakQsc0VBQXdEO0FBQ3hELHdGQUEwRTtBQUMxRSx3RUFBMEQ7QUFDMUQseURBQTJDO0FBQzNDLGlFQUFtRDtBQUNuRCx5RUFBMkQ7QUFDM0Qsd0VBQTBEO0FBQzFELHNGQUF3RTtBQUN4RSx1RUFBeUQ7QUFDekQsNEVBQThEO0FBQzlELGlFQUFtRDtBQUNuRCxtRUFBcUQ7QUFFckQsMkNBQTZCO0FBRTdCLE1BQWEsMEJBQTJCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDdkQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLG9CQUFvQixHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsc0JBQXNCLENBQUMsQ0FBQztRQUNqRSxJQUFJLENBQUMsb0JBQW9CLEVBQUUsQ0FBQztZQUMxQixNQUFNLElBQUksS0FBSyxDQUFDLHVEQUF1RCxDQUFDLENBQUM7UUFDM0UsQ0FBQztRQUVELE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztRQUNyRCxJQUFJLENBQUMsY0FBYyxFQUFFLENBQUM7WUFDcEIsTUFBTSxJQUFJLEtBQUssQ0FBQyxpREFBaUQsQ0FBQyxDQUFDO1FBQ3JFLENBQUM7UUFFRCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixDQUFDLENBQUM7UUFDckQsSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO1lBQ3BCLE1B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QUFDLGNBQWMsQ0FBQyx1QkFBdUIsRUFBRSxzQkFBc0IsQ0FBQyxDQUFDO2dCQUNuRSxFQUFFLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1lBQzNDLENBQUM7WUFFRCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtnQkFDcEMsS0FBSyxFQUFFLFdBQVcsWUFBWSxFQUFFO2FBQ2pDLENBQUMsQ0FBQztRQUNMLENBQUM7YUFBTSxDQUFDO1lBQ04sSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7Z0JBQ3BDLEtBQUssRUFBRSxPQUFPLENBQUMsV0FBVzthQUMzQixDQUFDLENBQUM7UUFDTCxDQUFDO0lBQ0gsQ0FBQztDQUNGO0FBbmhDRCxnRUFtaENDO0FBRUQsU0FBUyxpQkFBaUIsQ0FDeEIsWUFBZ0M7SUFFaEMsSUFBSSxDQUFDLFlBQVk7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUNwQyxNQUFNLEtBQUssR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3RDLElBQUksS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyx1QkFBdUIsR0FBRyxZQUFZLENBQUMsQ0FBQztJQUM5RSxPQUFPLEtBQUssQ0FBQyxNQUFNLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ3RFLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSBcImF3cy1jZGstbGliL2NvcmVcIjtcbmltcG9ydCB7IFNlY3JldFZhbHVlIH0gZnJvbSBcImF3cy1jZGstbGliL2NvcmVcIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgaW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgc2VjcmV0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgKiBhcyB0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGF1dGhvcml6ZXJzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWF1dGhvcml6ZXJzXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgY3IgZnJvbSBcImF3cy1jZGstbGliL2N1c3RvbS1yZXNvdXJjZXNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gXCJwYXRoXCI7XG5cbmV4cG9ydCBjbGFzcyBIZXJleWFBd3NNY3BBcHBMYW1iZGFTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIGNvbnN0IGhlcmV5YVByb2plY3RSb290RGlyID0gcHJvY2Vzcy5lbnZbXCJoZXJleWFQcm9qZWN0Um9vdERpclwiXTtcbiAgICBpZiAoIWhlcmV5YVByb2plY3RSb290RGlyKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJoZXJleWFQcm9qZWN0Um9vdERpciBlbnZpcm9ubWVudCB2YXJpYWJsZSBpcyByZXF1aXJlZFwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBvYXV0aFNlcnZlclVybCA9IHByb2Nlc3MuZW52W1wib2F1dGhTZXJ2ZXJVcmxcIl07XG4gICAgaWYgKCFvYXV0aFNlcnZlclVybCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwib2F1dGhTZXJ2ZXJVcmwgZW52aXJvbm1lbnQgdmFyaWFibGUgaXMgcmVxdWlyZWRcIik7XG4gICAgfVxuXG4gICAgY29uc3Qgb3JnYW5pemF0aW9uSWQgPSBwcm9jZXNzLmVudltcIm9yZ2FuaXphdGlvbklkXCJdO1xuICAgIGlmICghb3JnYW5pemF0aW9uSWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIm9yZ2FuaXphdGlvbklkIGVudmlyb25tZW50IHZhcmlhYmxlIGlzIHJlcXVpcmVkXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IG1lbW9yeVNpemUgPSBwcm9jZXNzLmVudltcIm1lbW9yeVNpemVcIl1cbiAgICAgID8gcGFyc2VJbnQocHJvY2Vzcy5lbnZbXCJtZW1vcnlTaXplXCJdKVxuICAgICAgOiAyNTY7XG4gICAgY29uc3QgdGltZW91dCA9IHByb2Nlc3MuZW52W1widGltZW91dFwiXVxuICAgICAgPyBwYXJzZUludChwcm9jZXNzLmVudltcInRpbWVvdXRcIl0pXG4gICAgICA6IDMwO1xuICAgIGNvbnN0IGhhbmRsZXJOYW1lID0gcHJvY2Vzcy5lbnZbXCJoYW5kbGVyXCJdID8/IFwiaGFuZGxlci5oYW5kbGVyXCI7XG4gICAgY29uc3QgY3VzdG9tRG9tYWluID0gcHJvY2Vzcy5lbnZbXCJjdXN0b21Eb21haW5cIl07XG4gICAgY29uc3QgY3VzdG9tRG9tYWluWm9uZSA9XG4gICAgICBwcm9jZXNzLmVudltcImN1c3RvbURvbWFpblpvbmVcIl0gPz8gZXh0cmFjdERvbWFpblpvbmUoY3VzdG9tRG9tYWluKTtcbiAgICBjb25zdCB3aWxkY2FyZENlcnRpZmljYXRlQXJuID0gcHJvY2Vzcy5lbnZbXCJ3aWxkY2FyZENlcnRpZmljYXRlQXJuXCJdO1xuICAgIC8vIEV4dHJhIHJlcXVlc3QgaGVhZGVycyB0aGUgZnJvbnRlbmQgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gc2hvdWxkIGZvcndhcmQgdG9cbiAgICAvLyBvcmlnaW4gKGNvbW1hLXNlcGFyYXRlZCkuIENsb3VkRnJvbnQgc3RyaXBzIGFueSBoZWFkZXIgbm90IHdoaXRlbGlzdGVkLCBzb1xuICAgIC8vIGN1c3RvbSBhdXRoL3dlYmhvb2sgaGVhZGVycyBtdXN0IGJlIGxpc3RlZCBoZXJlLiBOT1RFOiBgQXV0aG9yaXphdGlvbmAgQ0FOTk9UXG4gICAgLy8gYmUgYWRkZWQgdG8gYW4gT3JpZ2luUmVxdWVzdFBvbGljeSAoQVdTIG9ubHkgYWxsb3dzIGl0IHZpYSBhIGNhY2hlIHBvbGljeSkg4oCUXG4gICAgLy8gdXNlIGEgY3VzdG9tIGhlYWRlciBuYW1lIGluc3RlYWQgKGUuZy4gWC1EaWxheWEtQWdlbnQtVG9rZW4gZm9yIHRoZSBhZ2VudCBwb2xsKS5cbiAgICBjb25zdCBhZGRpdGlvbmFsRm9yd2FyZGVkSGVhZGVycyA9IChwcm9jZXNzLmVudltcImFkZGl0aW9uYWxGb3J3YXJkZWRIZWFkZXJzXCJdID8/IFwiXCIpXG4gICAgICAuc3BsaXQoXCIsXCIpXG4gICAgICAubWFwKChoKSA9PiBoLnRyaW0oKSlcbiAgICAgIC5maWx0ZXIoQm9vbGVhbik7XG4gICAgY29uc3QgZnJvbnRlbmRGb3J3YXJkSGVhZGVycyA9IFtcbiAgICAgIFwiQ29udGVudC1UeXBlXCIsXG4gICAgICBcIkFjY2VwdC1MYW5ndWFnZVwiLFxuICAgICAgXCJ4LWZvcndhcmRlZC1ob3N0XCIsXG4gICAgICBcIlgtVGVsZWdyYW0tQm90LUFwaS1TZWNyZXQtVG9rZW5cIixcbiAgICAgIC4uLmFkZGl0aW9uYWxGb3J3YXJkZWRIZWFkZXJzLFxuICAgIF0uZmlsdGVyKChoLCBpLCBhKSA9PiBhLmZpbmRJbmRleCgoeCkgPT4geC50b0xvd2VyQ2FzZSgpID09PSBoLnRvTG93ZXJDYXNlKCkpID09PSBpKTtcblxuICAgIC8vIFBhcnNlIGhlcmV5YVByb2plY3RFbnZcbiAgICBjb25zdCBlbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSBKU09OLnBhcnNlKFxuICAgICAgcHJvY2Vzcy5lbnZbXCJoZXJleWFQcm9qZWN0RW52XCJdID8/IFwie31cIlxuICAgICk7XG5cbiAgICAvLyBTZXBhcmF0ZSBJQU0gcG9saWN5IGVudiB2YXJzXG4gICAgY29uc3QgcG9saWN5RW52ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgT2JqZWN0LmVudHJpZXMoZW52KS5maWx0ZXIoXG4gICAgICAgIChba2V5XSkgPT4ga2V5LnN0YXJ0c1dpdGgoXCJJQU1fUE9MSUNZX1wiKSB8fCBrZXkuc3RhcnRzV2l0aChcImlhbVBvbGljeVwiKVxuICAgICAgKVxuICAgICk7XG5cbiAgICBjb25zdCBub25Qb2xpY3lFbnYgPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICBPYmplY3QuZW50cmllcyhlbnYpLmZpbHRlcihcbiAgICAgICAgKFtrZXldKSA9PlxuICAgICAgICAgICFrZXkuc3RhcnRzV2l0aChcIklBTV9QT0xJQ1lfXCIpICYmICFrZXkuc3RhcnRzV2l0aChcImlhbVBvbGljeVwiKVxuICAgICAgKVxuICAgICk7XG5cbiAgICAvLyBTZXBhcmF0ZSBzZWNyZXQgZW52IHZhcnMgKHNlY3JldDovLyBwcmVmaXgpXG4gICAgY29uc3Qgc2VjcmV0RW52RW50cmllcyA9IE9iamVjdC5lbnRyaWVzKG5vblBvbGljeUVudilcbiAgICAgIC5maWx0ZXIoKFssIHZhbHVlXSkgPT4gKHZhbHVlIGFzIHN0cmluZykuc3RhcnRzV2l0aChcInNlY3JldDovL1wiKSlcbiAgICAgIC5tYXAoKFtrZXksIHZhbHVlXSkgPT4ge1xuICAgICAgICBjb25zdCBwbGFpblZhbHVlID0gKHZhbHVlIGFzIHN0cmluZykuc3BsaXQoXCJzZWNyZXQ6Ly9cIilbMV07XG4gICAgICAgIGNvbnN0IHNlY3JldE5hbWUgPSBgLyR7dGhpcy5zdGFja05hbWV9LyR7a2V5fWA7XG4gICAgICAgIGNvbnN0IHNlY3JldCA9IG5ldyBzZWNyZXRzLlNlY3JldCh0aGlzLCBrZXksIHtcbiAgICAgICAgICBzZWNyZXROYW1lLFxuICAgICAgICAgIHNlY3JldFN0cmluZ1ZhbHVlOiBTZWNyZXRWYWx1ZS51bnNhZmVQbGFpblRleHQocGxhaW5WYWx1ZSksXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBrZXksIHNlY3JldCwgc2VjcmV0TmFtZSB9O1xuICAgICAgfSk7XG5cbiAgICBjb25zdCBwbGFpbkVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIE9iamVjdC5lbnRyaWVzKG5vblBvbGljeUVudikuZmlsdGVyKFxuICAgICAgICAoWywgdmFsdWVdKSA9PiAhKHZhbHVlIGFzIHN0cmluZykuc3RhcnRzV2l0aChcInNlY3JldDovL1wiKVxuICAgICAgKVxuICAgICk7XG5cblxuICAgIC8vIENvZ25pdG8gY29uZmlnIChmcm9tIGF3cy9jb2duaXRvIHBhY2thZ2Ugb3V0cHV0cyB2aWEgaGVyZXlhUHJvamVjdEVudilcbiAgICBjb25zdCBjb2duaXRvVXNlclBvb2xJZCA9IHBsYWluRW52W1widXNlclBvb2xJZFwiXSA/PyBub25Qb2xpY3lFbnZbXCJ1c2VyUG9vbElkXCJdO1xuICAgIGNvbnN0IGNvZ25pdG9DbGllbnRJZCA9IHBsYWluRW52W1widXNlclBvb2xDbGllbnRJZFwiXSA/PyBub25Qb2xpY3lFbnZbXCJ1c2VyUG9vbENsaWVudElkXCJdO1xuICAgIGNvbnN0IGNvZ25pdG9SZWdpb24gPSBwbGFpbkVudltcImF3c0NvZ25pdG9SZWdpb25cIl0gPz8gbm9uUG9saWN5RW52W1wiYXdzQ29nbml0b1JlZ2lvblwiXSA/PyBwcm9jZXNzLmVudltcIkNES19ERUZBVUxUX1JFR0lPTlwiXSA/PyBcInVzLWVhc3QtMVwiO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBMYW1iZGEgbmFtaW5nIHByZWZpeCBmb3IgcGVyLWFwcCBMYW1iZGFzIChkZXJpdmVkIGZyb20gY3VzdG9tRG9tYWluKVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBjb25zdCBvcmdQcmVmaXggPSBjdXN0b21Eb21haW5cbiAgICAgID8gY3VzdG9tRG9tYWluLnNwbGl0KFwiLlwiKVswXVxuICAgICAgOiB0aGlzLnN0YWNrTmFtZS5zdWJzdHJpbmcoMCwgMjApO1xuICAgIGNvbnN0IGFwcExhbWJkYU5hbWVQcmVmaXggPSBgJHtvcmdQcmVmaXh9LWFwcC1gO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBMYW1iZGEgMTogQXBwIEhhbmRsZXIgKE9yZyBMYW1iZGEg4oCUIE1DUCBvbmx5KVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAvLyBQYXNzIGRlcGxveS10aW1lIGNvbmZpZyB2YXJzIHRvIHRoZSBoYW5kbGVyIChub3QgaW4gaGVyZXlhUHJvamVjdEVudilcbiAgICBpZiAoY3VzdG9tRG9tYWluKSB7XG4gICAgICBwbGFpbkVudltcImN1c3RvbURvbWFpblwiXSA9IGN1c3RvbURvbWFpbjtcbiAgICB9XG5cbiAgICBjb25zdCBmbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJIYW5kbGVyXCIsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YLFxuICAgICAgaGFuZGxlcjogaGFuZGxlck5hbWUsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKGhlcmV5YVByb2plY3RSb290RGlyLCBcImRpc3RcIikpLFxuICAgICAgbWVtb3J5U2l6ZSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKHRpbWVvdXQpLFxuICAgICAgZW52aXJvbm1lbnQ6IHBsYWluRW52LFxuICAgIH0pO1xuXG4gICAgLy8gQXR0YWNoIHNlY3JldCByZWZlcmVuY2VzIChzZWNyZXQgbmFtZSwgbm90IHZhbHVlKSBhbmQgZ3JhbnQgcmVhZCBhY2Nlc3NcbiAgICBjb25zdCBzZWNyZXRLZXlzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgeyBrZXksIHNlY3JldCwgc2VjcmV0TmFtZSB9IG9mIHNlY3JldEVudkVudHJpZXMpIHtcbiAgICAgIGZuLmFkZEVudmlyb25tZW50KGtleSwgc2VjcmV0TmFtZSk7XG4gICAgICBzZWNyZXQuZ3JhbnRSZWFkKGZuKTtcbiAgICAgIHNlY3JldEtleXMucHVzaChrZXkpO1xuICAgIH1cbiAgICBpZiAoc2VjcmV0S2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICBmbi5hZGRFbnZpcm9ubWVudChcIlNFQ1JFVF9LRVlTXCIsIHNlY3JldEtleXMuam9pbihcIixcIikpO1xuICAgIH1cblxuICAgIC8vIEF0dGFjaCBJQU0gcG9saWNpZXMgZnJvbSBkZXBlbmRlbmN5IHBhY2thZ2VzXG4gICAgZm9yIChjb25zdCBbLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocG9saWN5RW52KSkge1xuICAgICAgY29uc3QgcG9saWN5ID0gSlNPTi5wYXJzZSh2YWx1ZSBhcyBzdHJpbmcpO1xuICAgICAgZm9yIChjb25zdCBzdGF0ZW1lbnQgb2YgcG9saWN5LlN0YXRlbWVudCkge1xuICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3koaWFtLlBvbGljeVN0YXRlbWVudC5mcm9tSnNvbihzdGF0ZW1lbnQpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIFNoYXJlZCBJQU0gUm9sZSBmb3IgcGVyLWFwcCBMYW1iZGFzXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IGFwcExhbWJkYVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgXCJBcHBMYW1iZGFSb2xlXCIsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwibGFtYmRhLmFtYXpvbmF3cy5jb21cIiksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbU1hbmFnZWRQb2xpY3lBcm4oXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICBcIkFwcExhbWJkYUJhc2ljRXhlY1wiLFxuICAgICAgICAgIFwiYXJuOmF3czppYW06OmF3czpwb2xpY3kvc2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZVwiXG4gICAgICAgICksXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gQXBwbHkgc2FtZSBJQU0gcG9saWNpZXMgZnJvbSBkZXBlbmRlbmN5IHBhY2thZ2VzIChBdXJvcmEsIFMzLCBldGMuKVxuICAgIGZvciAoY29uc3QgWywgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHBvbGljeUVudikpIHtcbiAgICAgIGNvbnN0IHBvbGljeSA9IEpTT04ucGFyc2UodmFsdWUgYXMgc3RyaW5nKTtcbiAgICAgIGZvciAoY29uc3Qgc3RhdGVtZW50IG9mIHBvbGljeS5TdGF0ZW1lbnQpIHtcbiAgICAgICAgYXBwTGFtYmRhUm9sZS5hZGRUb1BvbGljeShpYW0uUG9saWN5U3RhdGVtZW50LmZyb21Kc29uKHN0YXRlbWVudCkpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gTGFtYmRhIExheWVyIGZvciBwZXItYXBwIHJ1bnRpbWUgdXRpbGl0aWVzXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IHJ1bnRpbWVMYXllciA9IG5ldyBsYW1iZGEuTGF5ZXJWZXJzaW9uKHRoaXMsIFwiQXBwUnVudGltZUxheWVyXCIsIHtcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcbiAgICAgICAgcGF0aC5qb2luKGhlcmV5YVByb2plY3RSb290RGlyLCBcImRpc3RcIiwgXCJsYXllclwiKVxuICAgICAgKSxcbiAgICAgIGNvbXBhdGlibGVSdW50aW1lczogW2xhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YXSxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkhlcmV5YSBydW50aW1lIChkYiwgc3RvcmFnZSkgZm9yIHBlci1hcHAgTGFtYmRhc1wiLFxuICAgIH0pO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBQZXItYXBwIGF1dGg6IHNoYXJlZCBtdWx0aS10ZW5hbnQgQ29nbml0byB0cmlnZ2VycyArIE9UUCB0YWJsZS5cbiAgICAvL1xuICAgIC8vIGBlbmFibGUtYXV0aGAgcHJvdmlzaW9ucyBhIGRlZGljYXRlZCBDb2duaXRvIHVzZXIgcG9vbCBwZXIgYXBwLiBBbGxcbiAgICAvLyBwb29scyBhY3Jvc3MgdGhlIG9yZyBhcmUgd2lyZWQgdG8gdGhlIHNhbWUgNCBjaGFsbGVuZ2UgdHJpZ2dlciBMYW1iZGFzXG4gICAgLy8gZGVjbGFyZWQgaGVyZSDigJQgdGhlIHRyaWdnZXJzIGFyZSBwb29sLWFnbm9zdGljICh0aGV5IHJlYWRcbiAgICAvLyBldmVudC51c2VyUG9vbElkIGF0IHJ1bnRpbWUpLiBUaGUgT1RQIHRhYmxlIGlzIGtleWVkIGJ5XG4gICAgLy8gKHBvb2xfaWQsIGVtYWlsKSBzbyBjb25jdXJyZW50IGxvZ2lucyBhY3Jvc3MgcG9vbHMgY2FuJ3QgY29sbGlkZS5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3Qgb3RwVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJBcHBBdXRoT3RwVGFibGVcIiwge1xuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6IFwicG9vbF9pZFwiLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6IFwiZW1haWxcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcInR0bFwiLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHRyaWdnZXJFbnYgPSB7IE9UUF9UQUJMRV9OQU1FOiBvdHBUYWJsZS50YWJsZU5hbWUgfTtcbiAgICBjb25zdCBtYWtlVHJpZ2dlciA9IChpZDogc3RyaW5nLCBkaXI6IHN0cmluZykgPT5cbiAgICAgIG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgaWQsIHtcbiAgICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoXG4gICAgICAgICAgcGF0aC5qb2luKF9fZGlybmFtZSwgXCJjb2duaXRvLXRyaWdnZXJzXCIsIGRpcilcbiAgICAgICAgKSxcbiAgICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgICAgIGVudmlyb25tZW50OiB0cmlnZ2VyRW52LFxuICAgICAgfSk7XG5cbiAgICBjb25zdCBwcmVTaWduVXBGbiA9IG1ha2VUcmlnZ2VyKFwiUHJlU2lnblVwVHJpZ2dlclwiLCBcInByZS1zaWduLXVwXCIpO1xuICAgIGNvbnN0IGRlZmluZUNoYWxsZW5nZUZuID0gbWFrZVRyaWdnZXIoXG4gICAgICBcIkRlZmluZUF1dGhDaGFsbGVuZ2VUcmlnZ2VyXCIsXG4gICAgICBcImRlZmluZS1hdXRoLWNoYWxsZW5nZVwiXG4gICAgKTtcbiAgICBjb25zdCBjcmVhdGVDaGFsbGVuZ2VGbiA9IG1ha2VUcmlnZ2VyKFxuICAgICAgXCJDcmVhdGVBdXRoQ2hhbGxlbmdlVHJpZ2dlclwiLFxuICAgICAgXCJjcmVhdGUtYXV0aC1jaGFsbGVuZ2VcIlxuICAgICk7XG4gICAgY29uc3QgdmVyaWZ5Q2hhbGxlbmdlRm4gPSBtYWtlVHJpZ2dlcihcbiAgICAgIFwiVmVyaWZ5QXV0aENoYWxsZW5nZVRyaWdnZXJcIixcbiAgICAgIFwidmVyaWZ5LWF1dGgtY2hhbGxlbmdlXCJcbiAgICApO1xuXG4gICAgb3RwVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGNyZWF0ZUNoYWxsZW5nZUZuKTtcbiAgICBvdHBUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEodmVyaWZ5Q2hhbGxlbmdlRm4pO1xuXG4gICAgLy8gVmVyaWZ5IHRyaWdnZXIgYWxzbyB1cGRhdGVzIHRoZSBDb2duaXRvIHVzZXIgYXR0cmlidXRlIGBlbWFpbF92ZXJpZmllZGAuXG4gICAgLy8gU2NvcGluZyB0byByZXNvdXJjZT1cIipcIiBiZWNhdXNlIHBlci1hcHAgcG9vbHMgYXJlIGNyZWF0ZWQgYXQgcnVudGltZSBieVxuICAgIC8vIHRoZSBvcmcgTGFtYmRhIOKAlCB3ZSBjYW4ndCBwaW4gYSBzaW5nbGUgQVJOIGF0IHN0YWNrIGRlcGxveSB0aW1lLlxuICAgIHZlcmlmeUNoYWxsZW5nZUZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wiY29nbml0by1pZHA6QWRtaW5VcGRhdGVVc2VyQXR0cmlidXRlc1wiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgY29uc3QgdHJpZ2dlckFybnMgPSBbXG4gICAgICBwcmVTaWduVXBGbi5mdW5jdGlvbkFybixcbiAgICAgIGRlZmluZUNoYWxsZW5nZUZuLmZ1bmN0aW9uQXJuLFxuICAgICAgY3JlYXRlQ2hhbGxlbmdlRm4uZnVuY3Rpb25Bcm4sXG4gICAgICB2ZXJpZnlDaGFsbGVuZ2VGbi5mdW5jdGlvbkFybixcbiAgICBdO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBNQ1AgT0F1dGggQXV0aG9yaXplciBMYW1iZGFcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3QgYXV0aG9yaXplckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIkF1dGhvcml6ZXJIYW5kbGVyXCIsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YLFxuICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgXCJhdXRob3JpemVyXCIpKSxcbiAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEwKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIE9BVVRIX1NFUlZFUl9VUkw6IG9hdXRoU2VydmVyVXJsLFxuICAgICAgICBCT1VORF9PUkdfSUQ6IG9yZ2FuaXphdGlvbklkLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGh0dHBBdXRob3JpemVyID0gbmV3IGF1dGhvcml6ZXJzLkh0dHBMYW1iZGFBdXRob3JpemVyKFxuICAgICAgXCJIZXJleWFBdXRob3JpemVyXCIsXG4gICAgICBhdXRob3JpemVyRm4sXG4gICAgICB7XG4gICAgICAgIHJlc3BvbnNlVHlwZXM6IFthdXRob3JpemVycy5IdHRwTGFtYmRhUmVzcG9uc2VUeXBlLlNJTVBMRV0sXG4gICAgICAgIHJlc3VsdHNDYWNoZVR0bDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gSFRUUCBBUElcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3QgaHR0cEFwaSA9IG5ldyBhcGlnd3YyLkh0dHBBcGkodGhpcywgXCJIdHRwQXBpXCIsIHtcbiAgICAgIGFwaU5hbWU6IHRoaXMuc3RhY2tOYW1lLFxuICAgIH0pO1xuXG4gICAgY29uc3QgbGFtYmRhSW50ZWdyYXRpb24gPSBuZXcgaW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgIFwiTGFtYmRhSW50ZWdyYXRpb25cIixcbiAgICAgIGZuXG4gICAgKTtcblxuICAgIC8vIENvbXB1dGUgc2VydmljZSBVUkwgZm9yIFBSTSAoY3VzdG9tIGRvbWFpbiBvciBBUEkgZW5kcG9pbnQpXG4gICAgY29uc3Qgc2VydmljZVVybCA9IGN1c3RvbURvbWFpblxuICAgICAgPyBgaHR0cHM6Ly8ke2N1c3RvbURvbWFpbn1gXG4gICAgICA6IGh0dHBBcGkuYXBpRW5kcG9pbnQ7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIFByb3RlY3RlZCBSZXNvdXJjZSBNZXRhZGF0YSAoUkZDIDk3MjgpXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IHBybUxhbWJkYSA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJQcm1IYW5kbGVyXCIsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YLFxuICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbiAgICAgICAgZXhwb3J0cy5oYW5kbGVyID0gYXN5bmMgKCkgPT4gKHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgICAgICAgICBcIkNhY2hlLUNvbnRyb2xcIjogXCJwdWJsaWMsIG1heC1hZ2U9MzYwMFwiLFxuICAgICAgICAgICAgXCJBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogXCIqXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICByZXNvdXJjZTogcHJvY2Vzcy5lbnYuU0VSVklDRV9VUkwgKyBcIi9tY3BcIixcbiAgICAgICAgICAgIGF1dGhvcml6YXRpb25fc2VydmVyczogW3Byb2Nlc3MuZW52Lk9BVVRIX1NFUlZFUl9VUkwgKyBcIi9vYXV0aC9cIiArIHByb2Nlc3MuZW52Lk9SR0FOSVpBVElPTl9JRF0sXG4gICAgICAgICAgICBiZWFyZXJfbWV0aG9kc19zdXBwb3J0ZWQ6IFtcImhlYWRlclwiXSxcbiAgICAgICAgICAgIHNjb3Blc19zdXBwb3J0ZWQ6IFtcIm1jcDphY2Nlc3NcIl0sXG4gICAgICAgICAgfSksXG4gICAgICAgIH0pO1xuICAgICAgYCksXG4gICAgICBtZW1vcnlTaXplOiAxMjgsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg1KSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFNFUlZJQ0VfVVJMOiBzZXJ2aWNlVXJsLFxuICAgICAgICBPQVVUSF9TRVJWRVJfVVJMOiBvYXV0aFNlcnZlclVybCxcbiAgICAgICAgT1JHQU5JWkFUSU9OX0lEOiBvcmdhbml6YXRpb25JZCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBodHRwQXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiBcIi8ud2VsbC1rbm93bi9vYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2VcIixcbiAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBuZXcgaW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICAgXCJQcm1JbnRlZ3JhdGlvblwiLFxuICAgICAgICBwcm1MYW1iZGFcbiAgICAgICksXG4gICAgfSk7XG5cbiAgICAvLyBNQ1Agcm91dGUgKGV4aXN0aW5nKVxuICAgIGh0dHBBcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiL21jcFwiLFxuICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiBsYW1iZGFJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IGh0dHBBdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgLy8gQWxsb3cgQVBJIEdhdGV3YXkgdG8gaW52b2tlIHRoZSBvcmcgTGFtYmRhIG9uIEFOWSByb3V0ZSBvZiB0aGlzIEFQSS5cbiAgICAvLyBIdHRwTGFtYmRhSW50ZWdyYXRpb24gb25seSBncmFudHMgYSByb3V0ZS1zcGVjaWZpYyBwZXJtaXNzaW9uIGZvciAvbWNwLFxuICAgIC8vIGJ1dCB0aGUgb3JnIExhbWJkYSBjcmVhdGVzIGFkZGl0aW9uYWwgcm91dGVzIGF0IHJ1bnRpbWUgdGhhdCB0YXJnZXRcbiAgICAvLyBpdHNlbGYgKGUuZy4gcGVyLWFwcCBUZWxlZ3JhbSB3ZWJob29rcyBhdCAve3NjaGVtYX0vdGVsZWdyYW0ve3Byb3h5K30pLlxuICAgIC8vIFdpdGhvdXQgYW4gYXBpLXNjb3BlZCBwZXJtaXNzaW9uIHRob3NlIHJvdXRlcyByZXR1cm4gNTAwIChBUEkgR2F0ZXdheVxuICAgIC8vIGNhbm5vdCBpbnZva2UgdGhlIExhbWJkYSksIGFuZCB0aGUgb3JnIExhbWJkYSBjYW5ub3Qgc2VsZi1ncmFudFxuICAgIC8vIChpdHMgbGFtYmRhOkFkZFBlcm1pc3Npb24gSUFNIGlzIHNjb3BlZCB0byBwZXItYXBwIGZ1bmN0aW9uIG5hbWVzIG9ubHkpLlxuICAgIGZuLmFkZFBlcm1pc3Npb24oXCJIdHRwQXBpSW52b2tlQWxsXCIsIHtcbiAgICAgIHByaW5jaXBhbDogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiYXBpZ2F0ZXdheS5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgc291cmNlQXJuOiBgYXJuOmF3czpleGVjdXRlLWFwaToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06JHtodHRwQXBpLmFwaUlkfS8qLypgLFxuICAgIH0pO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBGcm9udGVuZCBBdXRob3JpemVyICsgQXV0aCBMYW1iZGEgKGZvciBwZXItYXBwIExhbWJkYXMpXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIFRoZXNlIGFyZSBjcmVhdGVkIGF0IENESyB0aW1lLiBUaGVpciBJRHMgYXJlIHBhc3NlZCB0byB0aGUgb3JnIExhbWJkYVxuICAgIC8vIHNvIGl0IGNhbiBjcmVhdGUgcGVyLWFwcCBBUEkgR2F0ZXdheSByb3V0ZXMgZHluYW1pY2FsbHkuXG5cbiAgICBsZXQgZnJvbnRlbmRBdXRob3JpemVySWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgYXV0aEludGVncmF0aW9uSWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcblxuICAgIGlmIChjb2duaXRvVXNlclBvb2xJZCAmJiBjb2duaXRvQ2xpZW50SWQpIHtcbiAgICAgIC8vIEZyb250ZW5kIEF1dGhvcml6ZXIgTGFtYmRhIChtdWx0aS10ZW5hbnQ6IHBlci1hcHAgcG9vbCBsb29rdXAgdmlhIERCLFxuICAgICAgLy8gd2l0aCBzaGFyZWQtcG9vbCBmYWxsYmFjayBmb3IgUGhhc2UtQSBtaWdyYXRpb24pLlxuICAgICAgY29uc3QgZnJvbnRlbmRBdXRob3JpemVyRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKFxuICAgICAgICB0aGlzLFxuICAgICAgICBcIkZyb250ZW5kQXV0aG9yaXplckhhbmRsZXJcIixcbiAgICAgICAge1xuICAgICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YLFxuICAgICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcbiAgICAgICAgICAgIHBhdGguam9pbihfX2Rpcm5hbWUsIFwiZnJvbnRlbmQtYXV0aG9yaXplclwiKVxuICAgICAgICAgICksXG4gICAgICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEwKSxcbiAgICAgICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAgICAgQ09HTklUT19VU0VSX1BPT0xfSUQ6IGNvZ25pdG9Vc2VyUG9vbElkLFxuICAgICAgICAgICAgQ09HTklUT19SRUdJT046IGNvZ25pdG9SZWdpb24sXG4gICAgICAgICAgICBjbHVzdGVyQXJuOiBwbGFpbkVudltcImNsdXN0ZXJBcm5cIl0gPz8gXCJcIixcbiAgICAgICAgICAgIHNlY3JldEFybjogcGxhaW5FbnZbXCJzZWNyZXRBcm5cIl0gPz8gXCJcIixcbiAgICAgICAgICAgIGRhdGFiYXNlTmFtZTogcGxhaW5FbnZbXCJkYXRhYmFzZU5hbWVcIl0gPz8gXCJcIixcbiAgICAgICAgICB9LFxuICAgICAgICB9XG4gICAgICApO1xuXG4gICAgICAvLyBBcHBseSBBdXJvcmEgRGF0YSBBUEkgcG9saWNpZXMgZnJvbSBkZXAgcGFja2FnZXMgc28gdGhlIGF1dGhvcml6ZXIgY2FuXG4gICAgICAvLyBTRUxFQ1QgZnJvbSBwdWJsaWMuX2FwcF9hdXRoLlxuICAgICAgZm9yIChjb25zdCBbLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocG9saWN5RW52KSkge1xuICAgICAgICBjb25zdCBwb2xpY3kgPSBKU09OLnBhcnNlKHZhbHVlIGFzIHN0cmluZyk7XG4gICAgICAgIGZvciAoY29uc3Qgc3RhdGVtZW50IG9mIHBvbGljeS5TdGF0ZW1lbnQpIHtcbiAgICAgICAgICBmcm9udGVuZEF1dGhvcml6ZXJGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgICAgICBpYW0uUG9saWN5U3RhdGVtZW50LmZyb21Kc29uKHN0YXRlbWVudClcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEdyYW50IEFQSSBHYXRld2F5IHBlcm1pc3Npb24gdG8gaW52b2tlIHRoZSBmcm9udGVuZCBhdXRob3JpemVyXG4gICAgICBmcm9udGVuZEF1dGhvcml6ZXJGbi5hZGRQZXJtaXNzaW9uKFwiQXBpR3dBdXRob3JpemVySW52b2tlXCIsIHtcbiAgICAgICAgcHJpbmNpcGFsOiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJhcGlnYXRld2F5LmFtYXpvbmF3cy5jb21cIiksXG4gICAgICAgIHNvdXJjZUFybjogYGFybjphd3M6ZXhlY3V0ZS1hcGk6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OiR7aHR0cEFwaS5hcGlJZH0vKmAsXG4gICAgICB9KTtcblxuICAgICAgLy8gRnJvbnRlbmQgQXV0aG9yaXplciBhcyBMMSBjb25zdHJ1Y3QgKHRvIGdldCBhdXRob3JpemVyIElEKVxuICAgICAgY29uc3QgZnJvbnRlbmRBdXRob3JpemVyQ2ZuID0gbmV3IGFwaWd3djIuQ2ZuQXV0aG9yaXplcihcbiAgICAgICAgdGhpcyxcbiAgICAgICAgXCJGcm9udGVuZEF1dGhvcml6ZXJDZm5cIixcbiAgICAgICAge1xuICAgICAgICAgIGFwaUlkOiBodHRwQXBpLmFwaUlkLFxuICAgICAgICAgIGF1dGhvcml6ZXJUeXBlOiBcIlJFUVVFU1RcIixcbiAgICAgICAgICBhdXRob3JpemVyVXJpOiBgYXJuOmF3czphcGlnYXRld2F5OiR7dGhpcy5yZWdpb259OmxhbWJkYTpwYXRoLzIwMTUtMDMtMzEvZnVuY3Rpb25zLyR7ZnJvbnRlbmRBdXRob3JpemVyRm4uZnVuY3Rpb25Bcm59L2ludm9jYXRpb25zYCxcbiAgICAgICAgICBhdXRob3JpemVyUGF5bG9hZEZvcm1hdFZlcnNpb246IFwiMi4wXCIsXG4gICAgICAgICAgZW5hYmxlU2ltcGxlUmVzcG9uc2VzOiB0cnVlLFxuICAgICAgICAgIGF1dGhvcml6ZXJSZXN1bHRUdGxJblNlY29uZHM6IDAsXG4gICAgICAgICAgaWRlbnRpdHlTb3VyY2U6IFtdIGFzIHN0cmluZ1tdLCAvLyBlbXB0eSA9IGFsd2F5cyBpbnZva2UgKHN1cHBvcnRzIHB1YmxpYyBlbmRwb2ludHMpXG4gICAgICAgICAgbmFtZTogXCJGcm9udGVuZEF1dGhvcml6ZXJWMlwiLFxuICAgICAgICB9XG4gICAgICApO1xuICAgICAgZnJvbnRlbmRBdXRob3JpemVySWQgPSBmcm9udGVuZEF1dGhvcml6ZXJDZm4ucmVmO1xuXG4gICAgICAvLyBBdXRoIExhbWJkYSAobG9naW4vT1RQL3ZlcmlmeS9sb2dvdXQpLiBNdWx0aS10ZW5hbnQ6IGV4dHJhY3RzIGFwcCBmcm9tXG4gICAgICAvLyBwYXRoLCBsb29rcyB1cCBwZXItYXBwIHBvb2wgY2xpZW50ICsgUG9zdG1hcmsgdG9rZW4sIGZhbGxzIGJhY2sgdG8gdGhlXG4gICAgICAvLyBzaGFyZWQgb3JnIHBvb2wgZm9yIHVubWlncmF0ZWQgYXBwcy5cbiAgICAgIGNvbnN0IGF1dGhMYW1iZGFFbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICAgIENPR05JVE9fVVNFUl9QT09MX0lEOiBjb2duaXRvVXNlclBvb2xJZCxcbiAgICAgICAgQ09HTklUT19DTElFTlRfSUQ6IGNvZ25pdG9DbGllbnRJZCxcbiAgICAgICAgQ09HTklUT19SRUdJT046IGNvZ25pdG9SZWdpb24sXG4gICAgICAgIENVU1RPTV9ET01BSU46IGN1c3RvbURvbWFpbiA/PyBcIlwiLFxuICAgICAgICBCVUNLRVRfTkFNRTogcGxhaW5FbnZbXCJidWNrZXROYW1lXCJdID8/IFwiXCIsXG4gICAgICAgIFMzX1BSRUZJWDogcGxhaW5FbnZbXCJzM1ByZWZpeFwiXSA/PyBcIlwiLFxuICAgICAgICBPUkdBTklaQVRJT05fSUQ6IG9yZ2FuaXphdGlvbklkLFxuICAgICAgICBjbHVzdGVyQXJuOiBwbGFpbkVudltcImNsdXN0ZXJBcm5cIl0gPz8gXCJcIixcbiAgICAgICAgc2VjcmV0QXJuOiBwbGFpbkVudltcInNlY3JldEFyblwiXSA/PyBcIlwiLFxuICAgICAgICBkYXRhYmFzZU5hbWU6IHBsYWluRW52W1wiZGF0YWJhc2VOYW1lXCJdID8/IFwiXCIsXG4gICAgICB9O1xuXG4gICAgICBjb25zdCBhdXRoTGFtYmRhRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiQXV0aExhbWJkYUhhbmRsZXJcIiwge1xuICAgICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWCxcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCBcImF1dGgtbGFtYmRhXCIpKSxcbiAgICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxNSksXG4gICAgICAgIGVudmlyb25tZW50OiBhdXRoTGFtYmRhRW52LFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEdyYW50IEF1dGggTGFtYmRhIGFjY2VzcyB0byBzZWNyZXRzXG4gICAgICBjb25zdCBhdXRoU2VjcmV0S2V5czogc3RyaW5nW10gPSBbXTtcbiAgICAgIGZvciAoY29uc3QgeyBrZXksIHNlY3JldCwgc2VjcmV0TmFtZSB9IG9mIHNlY3JldEVudkVudHJpZXMpIHtcbiAgICAgICAgYXV0aExhbWJkYUZuLmFkZEVudmlyb25tZW50KGtleSwgc2VjcmV0TmFtZSk7XG4gICAgICAgIHNlY3JldC5ncmFudFJlYWQoYXV0aExhbWJkYUZuKTtcbiAgICAgICAgYXV0aFNlY3JldEtleXMucHVzaChrZXkpO1xuICAgICAgfVxuICAgICAgaWYgKGF1dGhTZWNyZXRLZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgYXV0aExhbWJkYUZuLmFkZEVudmlyb25tZW50KFwiU0VDUkVUX0tFWVNcIiwgYXV0aFNlY3JldEtleXMuam9pbihcIixcIikpO1xuICAgICAgfVxuXG4gICAgICAvLyBHcmFudCBBdXRoIExhbWJkYSBDb2duaXRvIHBlcm1pc3Npb25zICsgRGF0YSBBUEkgKHRvIHJlYWQgX2FwcF9hdXRoKS5cbiAgICAgIGZvciAoY29uc3QgWywgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHBvbGljeUVudikpIHtcbiAgICAgICAgY29uc3QgcG9saWN5ID0gSlNPTi5wYXJzZSh2YWx1ZSBhcyBzdHJpbmcpO1xuICAgICAgICBmb3IgKGNvbnN0IHN0YXRlbWVudCBvZiBwb2xpY3kuU3RhdGVtZW50KSB7XG4gICAgICAgICAgYXV0aExhbWJkYUZuLmFkZFRvUm9sZVBvbGljeShpYW0uUG9saWN5U3RhdGVtZW50LmZyb21Kc29uKHN0YXRlbWVudCkpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFJlYWQgcGVyLWFwcCBQb3N0bWFyayBzZXJ2ZXIgdG9rZW4gZnJvbSBTU00gU2VjdXJlU3RyaW5nLlxuICAgICAgY29uc3QgYXBwQXV0aFNzbUFybiA9IGBhcm46YXdzOnNzbToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06cGFyYW1ldGVyL2hlcmV5YS8ke29yZ2FuaXphdGlvbklkfS9hcHBzLypgO1xuICAgICAgYXV0aExhbWJkYUZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGFjdGlvbnM6IFtcInNzbTpHZXRQYXJhbWV0ZXJcIl0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbYXBwQXV0aFNzbUFybl0sXG4gICAgICAgIH0pXG4gICAgICApO1xuICAgICAgYXV0aExhbWJkYUZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGFjdGlvbnM6IFtcImttczpEZWNyeXB0XCJdLFxuICAgICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAgICAgXCJrbXM6VmlhU2VydmljZVwiOiBgc3NtLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb21gLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9KVxuICAgICAgKTtcblxuICAgICAgLy8gQWxsb3cgSW5pdGlhdGVBdXRoIC8gUmVzcG9uZFRvQXV0aENoYWxsZW5nZSBhZ2FpbnN0IGFueSBwZXItYXBwIHBvb2xcbiAgICAgIC8vIGluIHRoaXMgYWNjb3VudCAocG9vbCBBUk5zIGFyZSBjcmVhdGVkIGF0IHJ1bnRpbWUgYnkgZW5hYmxlLWF1dGgpLlxuICAgICAgYXV0aExhbWJkYUZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgIFwiY29nbml0by1pZHA6SW5pdGlhdGVBdXRoXCIsXG4gICAgICAgICAgICBcImNvZ25pdG8taWRwOlJlc3BvbmRUb0F1dGhDaGFsbGVuZ2VcIixcbiAgICAgICAgICBdLFxuICAgICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICAgIC8vIEdyYW50IEFQSSBHYXRld2F5IHBlcm1pc3Npb24gdG8gaW52b2tlIGF1dGggTGFtYmRhXG4gICAgICBhdXRoTGFtYmRhRm4uYWRkUGVybWlzc2lvbihcIkFwaUd3SW52b2tlXCIsIHtcbiAgICAgICAgcHJpbmNpcGFsOiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJhcGlnYXRld2F5LmFtYXpvbmF3cy5jb21cIiksXG4gICAgICAgIHNvdXJjZUFybjogYGFybjphd3M6ZXhlY3V0ZS1hcGk6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OiR7aHR0cEFwaS5hcGlJZH0vKi8qYCxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBBdXRoIExhbWJkYSBpbnRlZ3JhdGlvbiBhcyBMMSBjb25zdHJ1Y3QgKHRvIGdldCBpbnRlZ3JhdGlvbiBJRClcbiAgICAgIGNvbnN0IGF1dGhJbnRlZ3JhdGlvbkNmbiA9IG5ldyBhcGlnd3YyLkNmbkludGVncmF0aW9uKFxuICAgICAgICB0aGlzLFxuICAgICAgICBcIkF1dGhJbnRlZ3JhdGlvbkNmblwiLFxuICAgICAgICB7XG4gICAgICAgICAgYXBpSWQ6IGh0dHBBcGkuYXBpSWQsXG4gICAgICAgICAgaW50ZWdyYXRpb25UeXBlOiBcIkFXU19QUk9YWVwiLFxuICAgICAgICAgIGludGVncmF0aW9uVXJpOiBhdXRoTGFtYmRhRm4uZnVuY3Rpb25Bcm4sXG4gICAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IFwiMi4wXCIsXG4gICAgICAgIH1cbiAgICAgICk7XG4gICAgICBhdXRoSW50ZWdyYXRpb25JZCA9IGF1dGhJbnRlZ3JhdGlvbkNmbi5yZWY7XG4gICAgfVxuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBPcmcgTGFtYmRhOiBwZXItYXBwIExhbWJkYSBtYW5hZ2VtZW50IHBlcm1pc3Npb25zXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IGFwcExhbWJkYUFyblBhdHRlcm4gPSBgYXJuOmF3czpsYW1iZGE6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmZ1bmN0aW9uOiR7YXBwTGFtYmRhTmFtZVByZWZpeH0qYDtcblxuICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwibGFtYmRhOkNyZWF0ZUZ1bmN0aW9uXCIsXG4gICAgICAgICAgXCJsYW1iZGE6VXBkYXRlRnVuY3Rpb25Db2RlXCIsXG4gICAgICAgICAgXCJsYW1iZGE6VXBkYXRlRnVuY3Rpb25Db25maWd1cmF0aW9uXCIsXG4gICAgICAgICAgXCJsYW1iZGE6R2V0RnVuY3Rpb25cIixcbiAgICAgICAgICBcImxhbWJkYTpEZWxldGVGdW5jdGlvblwiLFxuICAgICAgICAgIFwibGFtYmRhOkFkZFBlcm1pc3Npb25cIixcbiAgICAgICAgICBcImxhbWJkYTpSZW1vdmVQZXJtaXNzaW9uXCIsXG4gICAgICAgICAgXCJsYW1iZGE6SW52b2tlRnVuY3Rpb25cIixcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYXBwTGFtYmRhQXJuUGF0dGVybl0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyBMYW1iZGEgbGF5ZXIgYWNjZXNzIChuZWVkZWQgd2hlbiBjcmVhdGluZyBwZXItYXBwIExhbWJkYXMgd2l0aCBsYXllcnMpXG4gICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJsYW1iZGE6R2V0TGF5ZXJWZXJzaW9uXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtydW50aW1lTGF5ZXIubGF5ZXJWZXJzaW9uQXJuXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIEFQSSBHYXRld2F5IHJvdXRlIG1hbmFnZW1lbnRcbiAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcImFwaWdhdGV3YXk6UE9TVFwiLFxuICAgICAgICAgIFwiYXBpZ2F0ZXdheTpERUxFVEVcIixcbiAgICAgICAgICBcImFwaWdhdGV3YXk6R0VUXCIsXG4gICAgICAgICAgXCJhcGlnYXRld2F5OlBBVENIXCIsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgIGBhcm46YXdzOmFwaWdhdGV3YXk6JHt0aGlzLnJlZ2lvbn06Oi9hcGlzLyR7aHR0cEFwaS5hcGlJZH0vKmAsXG4gICAgICAgIF0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyBQYXNzIHNoYXJlZCByb2xlIHRvIHBlci1hcHAgTGFtYmRhc1xuICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wiaWFtOlBhc3NSb2xlXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFthcHBMYW1iZGFSb2xlLnJvbGVBcm5dLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBTU00gU2VjdXJlU3RyaW5nIGZvciBwZXItYXBwIGFnZW50LXNlc3Npb24gc2lnbmluZyBzZWNyZXRzLlxuICAgIC8vIFByZWZpeC1ib3VuZCB0byAvaGVyZXlhL3tvcmdhbml6YXRpb25JZH0vYXBwcy8qIHNvIHRoZSBvcmcgTGFtYmRhIGFuZFxuICAgIC8vIHBlci1hcHAgTGFtYmRhcyBjYW4gb25seSB0b3VjaCB0aGVpciBvd24gb3JnJ3Mgc2VjcmV0cy5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3QgYWdlbnRTZWNyZXRTc21Bcm4gPSBgYXJuOmF3czpzc206JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnBhcmFtZXRlci9oZXJleWEvJHtvcmdhbml6YXRpb25JZH0vYXBwcy8qYDtcblxuICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwic3NtOkdldFBhcmFtZXRlclwiLFxuICAgICAgICAgIFwic3NtOkdldFBhcmFtZXRlcnNcIixcbiAgICAgICAgICBcInNzbTpQdXRQYXJhbWV0ZXJcIixcbiAgICAgICAgICBcInNzbTpEZWxldGVQYXJhbWV0ZXJcIixcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYWdlbnRTZWNyZXRTc21Bcm5dLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgYXBwTGFtYmRhUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wic3NtOkdldFBhcmFtZXRlclwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYWdlbnRTZWNyZXRTc21Bcm5dLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gS01TIGRlY3J5cHQgZm9yIHRoZSBBV1MtbWFuYWdlZCBTU00ga2V5IChTZWN1cmVTdHJpbmcpLlxuICAgIC8vIFNjb3BlZCB2aWEgVmlhU2VydmljZSBjb25kaXRpb24gc28gaXQgb25seSB3b3JrcyB0aHJvdWdoIFNTTS5cbiAgICBjb25zdCBzc21LbXNEZWNyeXB0ID0gbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogW1wia21zOkRlY3J5cHRcIl0sXG4gICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgIFwia21zOlZpYVNlcnZpY2VcIjogYHNzbS4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tYCxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgZm4uYWRkVG9Sb2xlUG9saWN5KHNzbUttc0RlY3J5cHQpO1xuICAgIGFwcExhbWJkYVJvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcImttczpEZWNyeXB0XCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAgIFwia21zOlZpYVNlcnZpY2VcIjogYHNzbS4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tYCxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gUGVyLWFwcCBMYW1iZGFzIG1heSBvcHQgaW4gdG8gcmVnaXN0ZXJpbmcgdXNlcnMgc2VydmVyLXNpZGUgdmlhIHRoZVxuICAgIC8vIGhlcmV5YSBydW50aW1lJ3MgdXNlcnMuYWRkVXNlciBoZWxwZXIuIFNpbmNlIHBlci1hcHAgQ29nbml0byBwb29scyBhcmVcbiAgICAvLyBsb2NrZWQgdG8gQWxsb3dBZG1pbkNyZWF0ZVVzZXJPbmx5PXRydWUsIHRoZSBoZWxwZXIgY2FsbHNcbiAgICAvLyBBZG1pbkNyZWF0ZVVzZXIuIFNjb3BlIGJ5IHRoZSBIZXJleWFPcmcgdGFnIG9uIHRoZSBwb29sIHNvIG9uZSBvcmcnc1xuICAgIC8vIHBlci1hcHAgTGFtYmRhcyBjYW5ub3QgY3JlYXRlIHVzZXJzIGluIGFub3RoZXIgb3JnJ3MgcG9vbHMuXG4gICAgYXBwTGFtYmRhUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wiY29nbml0by1pZHA6QWRtaW5DcmVhdGVVc2VyXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAgIFwiYXdzOlJlc291cmNlVGFnL0hlcmV5YU9yZ1wiOiBvcmdhbml6YXRpb25JZCxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBPcmcgTGFtYmRhOiBlbnZpcm9ubWVudCB2YXJpYWJsZXMgZm9yIHBlci1hcHAgTGFtYmRhIG1hbmFnZW1lbnRcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJBUFBfTEFNQkRBX1JPTEVfQVJOXCIsIGFwcExhbWJkYVJvbGUucm9sZUFybik7XG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJBUFBfTEFNQkRBX05BTUVfUFJFRklYXCIsIGFwcExhbWJkYU5hbWVQcmVmaXgpO1xuICAgIGZuLmFkZEVudmlyb25tZW50KFwiQVBQX0xBTUJEQV9MQVlFUl9BUk5cIiwgcnVudGltZUxheWVyLmxheWVyVmVyc2lvbkFybik7XG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJIVFRQX0FQSV9JRFwiLCBodHRwQXBpLmFwaUlkKTtcbiAgICBmbi5hZGRFbnZpcm9ubWVudChcIkFXU19BQ0NPVU5UX0lEXCIsIHRoaXMuYWNjb3VudCk7XG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJPUkdBTklaQVRJT05fSURcIiwgb3JnYW5pemF0aW9uSWQpO1xuICAgIGZuLmFkZEVudmlyb25tZW50KFwiQUdFTlRfU0VDUkVUX1NTTV9QUkVGSVhcIiwgYC9oZXJleWEvJHtvcmdhbml6YXRpb25JZH0vYXBwc2ApO1xuICAgIGZuLmFkZEVudmlyb25tZW50KFwiQ09HTklUT19UUklHR0VSX0xBTUJEQV9BUk5TXCIsIHRyaWdnZXJBcm5zLmpvaW4oXCIsXCIpKTtcbiAgICBmbi5hZGRFbnZpcm9ubWVudChcImF3c1JlZ2lvblwiLCB0aGlzLnJlZ2lvbik7XG5cbiAgICBpZiAoZnJvbnRlbmRBdXRob3JpemVySWQpIHtcbiAgICAgIGZuLmFkZEVudmlyb25tZW50KFwiRlJPTlRFTkRfQVVUSE9SSVpFUl9JRFwiLCBmcm9udGVuZEF1dGhvcml6ZXJJZCk7XG4gICAgfVxuICAgIGlmIChhdXRoSW50ZWdyYXRpb25JZCkge1xuICAgICAgZm4uYWRkRW52aXJvbm1lbnQoXCJBVVRIX0lOVEVHUkFUSU9OX0lEXCIsIGF1dGhJbnRlZ3JhdGlvbklkKTtcbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIFBlci1hcHAgbGlnaHR3ZWlnaHQgc3RhdGUgdGFibGUgKER5bmFtb0RCLCBvbi1kZW1hbmQpLiBVc2VkIGZvciBjaGVhcFxuICAgIC8vIFwiaXMgdGhlcmUgc29tZXRoaW5nIG5ldz9cIiBmbGFncyBzbyBwb2xsaW5nIGxvb3BzIGRvbid0IGhhdmUgdG8gcXVlcnlcbiAgICAvLyBBdXJvcmEgKHdoaWNoIHdvdWxkIGtlZXAgaXQgZnJvbSBzY2FsaW5nIHRvIHplcm8pLiBPcmctc2NvcGVkIChvbmUgdGFibGVcbiAgICAvLyBwZXIgZGVwbG95bWVudCk7IGl0ZW1zIGFyZSBrZXllZCBwZXIgYXBwIHZpYSB0aGUgcGFydGl0aW9uIGtleS5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIGNvbnN0IGFwcFN0YXRlVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJBcHBTdGF0ZVRhYmxlXCIsIHtcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInBrXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcbiAgICBmbi5hZGRFbnZpcm9ubWVudChcIkFQUF9TVEFURV9UQUJMRVwiLCBhcHBTdGF0ZVRhYmxlLnRhYmxlTmFtZSk7XG4gICAgYXBwU3RhdGVUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoZm4pO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBPcmcgTGFtYmRhOiBwZXItYXBwIGF1dGggcHJvdmlzaW9uaW5nIHBlcm1pc3Npb25zIChlbmFibGUtYXV0aCB0b29sKS5cbiAgICAvL1xuICAgIC8vIFBlci1hcHAgQ29nbml0byBwb29scyArIGNsaWVudHMgYXJlIGNyZWF0ZWQgYXQgcnVudGltZSAocmVzb3VyY2VzIGFyZVxuICAgIC8vIG9ubHkga25vd24gYWZ0ZXIgQ3JlYXRlVXNlclBvb2wgc3VjY2VlZHMpLCBzbyByZXNvdXJjZT1cIipcIi4gVGhlIG9yZ1xuICAgIC8vIExhbWJkYSBuZWVkcyB0byBhdHRhY2ggdGhlIHNoYXJlZCB0cmlnZ2VyIExhbWJkYXMgdG8gZWFjaCBuZXcgcG9vbFxuICAgIC8vIChBZGRQZXJtaXNzaW9uKSBhbmQgY2xlYW4gdGhlbSB1cCBvbiBkcm9wLXNjaGVtYSAoUmVtb3ZlUGVybWlzc2lvbikuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwiY29nbml0by1pZHA6Q3JlYXRlVXNlclBvb2xcIixcbiAgICAgICAgICBcImNvZ25pdG8taWRwOkRlbGV0ZVVzZXJQb29sXCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpVcGRhdGVVc2VyUG9vbFwiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6RGVzY3JpYmVVc2VyUG9vbFwiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6TGlzdFVzZXJQb29sc1wiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6Q3JlYXRlVXNlclBvb2xDbGllbnRcIixcbiAgICAgICAgICBcImNvZ25pdG8taWRwOkRlbGV0ZVVzZXJQb29sQ2xpZW50XCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpVcGRhdGVVc2VyUG9vbENsaWVudFwiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6RGVzY3JpYmVVc2VyUG9vbENsaWVudFwiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6QWRtaW5DcmVhdGVVc2VyXCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpMaXN0VXNlcnNcIixcbiAgICAgICAgICBcImNvZ25pdG8taWRwOlRhZ1Jlc291cmNlXCIsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wibGFtYmRhOkFkZFBlcm1pc3Npb25cIiwgXCJsYW1iZGE6UmVtb3ZlUGVybWlzc2lvblwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiB0cmlnZ2VyQXJucyxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gQ3VzdG9tIGRvbWFpbiArIEROU1xuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBpZiAoY3VzdG9tRG9tYWluICYmIGN1c3RvbURvbWFpblpvbmUpIHtcbiAgICAgIGlmICghd2lsZGNhcmRDZXJ0aWZpY2F0ZUFybikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJ3aWxkY2FyZENlcnRpZmljYXRlQXJuIGlzIHJlcXVpcmVkIHdoZW4gY3VzdG9tRG9tYWluIGlzIHNldFwiXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGNlcnRpZmljYXRlID0gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybihcbiAgICAgICAgdGhpcyxcbiAgICAgICAgXCJDZXJ0aWZpY2F0ZVwiLFxuICAgICAgICB3aWxkY2FyZENlcnRpZmljYXRlQXJuXG4gICAgICApO1xuXG4gICAgICBjb25zdCBob3N0ZWRab25lID0gcm91dGU1My5Ib3N0ZWRab25lLmZyb21Mb29rdXAodGhpcywgXCJIb3N0ZWRab25lXCIsIHtcbiAgICAgICAgZG9tYWluTmFtZTogY3VzdG9tRG9tYWluWm9uZSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBFeHBvc2UgaG9zdGVkIHpvbmUgSUQgKyBncmFudCBSb3V0ZTUzIHJlY29yZC1zZXQgbWFuYWdlbWVudCBzbyB0aGVcbiAgICAgIC8vIG9yZyBMYW1iZGEgY2FuIHdyaXRlIERLSU0gKyByZXR1cm4tcGF0aCByZWNvcmRzIHdoZW4gcHJvdmlzaW9uaW5nXG4gICAgICAvLyBwZXItYXBwIFBvc3RtYXJrIGRvbWFpbnMgdmlhIGVuYWJsZS1hdXRoLlxuICAgICAgZm4uYWRkRW52aXJvbm1lbnQoXCJIT1NURURfWk9ORV9JRFwiLCBob3N0ZWRab25lLmhvc3RlZFpvbmVJZCk7XG4gICAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICBcInJvdXRlNTM6Q2hhbmdlUmVzb3VyY2VSZWNvcmRTZXRzXCIsXG4gICAgICAgICAgICBcInJvdXRlNTM6TGlzdFJlc291cmNlUmVjb3JkU2V0c1wiLFxuICAgICAgICAgICAgXCJyb3V0ZTUzOkdldEhvc3RlZFpvbmVcIixcbiAgICAgICAgICBdLFxuICAgICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgICAgYGFybjphd3M6cm91dGU1Mzo6Omhvc3RlZHpvbmUvJHtob3N0ZWRab25lLmhvc3RlZFpvbmVJZH1gLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgICAvLyBBUEkgR2F0ZXdheSBjdXN0b20gZG9tYWluIGZvciBNQ1AgKGV4YWN0IGRvbWFpbilcbiAgICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBuZXcgYXBpZ3d2Mi5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICAgIGRvbWFpbk5hbWU6IGN1c3RvbURvbWFpbixcbiAgICAgICAgY2VydGlmaWNhdGUsXG4gICAgICB9KTtcblxuICAgICAgbmV3IGFwaWd3djIuQXBpTWFwcGluZyh0aGlzLCBcIkFwaU1hcHBpbmdcIiwge1xuICAgICAgICBhcGk6IGh0dHBBcGksXG4gICAgICAgIGRvbWFpbk5hbWUsXG4gICAgICB9KTtcblxuICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogY3VzdG9tRG9tYWluLFxuICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhcbiAgICAgICAgICBuZXcgdGFyZ2V0cy5BcGlHYXRld2F5djJEb21haW5Qcm9wZXJ0aWVzKFxuICAgICAgICAgICAgZG9tYWluTmFtZS5yZWdpb25hbERvbWFpbk5hbWUsXG4gICAgICAgICAgICBkb21haW5OYW1lLnJlZ2lvbmFsSG9zdGVkWm9uZUlkXG4gICAgICAgICAgKVxuICAgICAgICApLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgIC8vIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIGZvciBmcm9udGVuZCAoKi57Y3VzdG9tRG9tYWlufSlcbiAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgICAgaWYgKGNvZ25pdG9Vc2VyUG9vbElkICYmIGNvZ25pdG9DbGllbnRJZCkge1xuICAgICAgICBjb25zdCBjbG91ZGZyb250Q2VydGlmaWNhdGUgPSBuZXcgYWNtLkRuc1ZhbGlkYXRlZENlcnRpZmljYXRlKFxuICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgXCJDbG91ZEZyb250Q2VydGlmaWNhdGVcIixcbiAgICAgICAgICB7XG4gICAgICAgICAgICBkb21haW5OYW1lOiBgKi4ke2N1c3RvbURvbWFpbn1gLFxuICAgICAgICAgICAgaG9zdGVkWm9uZSxcbiAgICAgICAgICAgIHJlZ2lvbjogXCJ1cy1lYXN0LTFcIixcbiAgICAgICAgICB9XG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gQ2xvdWRGcm9udCBGdW5jdGlvbjogZXh0cmFjdCBhcHAgc3ViZG9tYWluIOKGkiBwcmVwZW5kIHRvIHBhdGgsIGFuZFxuICAgICAgICAvLyAod2hlbiB0aGUgb3JnIExhbWJkYSByZWdlbmVyYXRlcyB0aGUgY29kZSkgcm91dGUgY3VzdG9tIHZhbml0eVxuICAgICAgICAvLyBkb21haW5zIHZpYSBhIHBlci1ob3N0IGRvbWFpbk1hcCBsb29rdXAuXG4gICAgICAgIC8vXG4gICAgICAgIC8vIFRoaXMgaW5saW5lIGNvZGUgaXMgdGhlIEJPT1RTVFJBUCB2ZXJzaW9uIHdpdGggYW4gZW1wdHkgZG9tYWluTWFwLlxuICAgICAgICAvLyBPbiB0aGUgZmlyc3QgYHNldC1jdXN0b20tZG9tYWluc2AvYGNoZWNrLWN1c3RvbS1kb21haW5zYCBjeWNsZSB0aGVcbiAgICAgICAgLy8gb3JnIExhbWJkYSBvdmVyd3JpdGVzIHRoaXMgZnVuY3Rpb24gd2l0aCBhIHJlZ2VuZXJhdGVkIHZlcnNpb24gdGhhdFxuICAgICAgICAvLyBjb250YWlucyB0aGUgYWN0aXZlIGRvbWFpbuKGknNjaGVtYSBtYXBwaW5nLiBUaGUgc2hhcGUgbXVzdCBtYXRjaFxuICAgICAgICAvLyBzcmMvY3VzdG9tLWRvbWFpbi10ZW1wbGF0ZS50cyBpbiB0aGUgaGVyZXlhLWFwcHMgcmVwbyBzbyBydW50aW1lXG4gICAgICAgIC8vIHVwZGF0ZXMgYXJlIGRyb3AtaW4gcmVwbGFjZW1lbnRzLlxuICAgICAgICBjb25zdCBjZkZ1bmN0aW9uID0gbmV3IGNsb3VkZnJvbnQuRnVuY3Rpb24odGhpcywgXCJTdWJkb21haW5SZXdyaXRlXCIsIHtcbiAgICAgICAgICBjb2RlOiBjbG91ZGZyb250LkZ1bmN0aW9uQ29kZS5mcm9tSW5saW5lKGBcbmZ1bmN0aW9uIGhhbmRsZXIoZXZlbnQpIHtcbiAgdmFyIHJlcXVlc3QgPSBldmVudC5yZXF1ZXN0O1xuICB2YXIgaG9zdCA9IHJlcXVlc3QuaGVhZGVycy5ob3N0LnZhbHVlO1xuICB2YXIgY3VzdG9tRG9tYWluID0gJHtKU09OLnN0cmluZ2lmeShjdXN0b21Eb21haW4pfTtcbiAgdmFyIGRvbWFpbk1hcCA9IHt9O1xuICBpZiAoZG9tYWluTWFwW2hvc3RdKSB7XG4gICAgcmVxdWVzdC51cmkgPSAnLycgKyBkb21haW5NYXBbaG9zdF0gKyByZXF1ZXN0LnVyaTtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoaG9zdCAhPT0gY3VzdG9tRG9tYWluICYmIGhvc3QuZW5kc1dpdGgoJy4nICsgY3VzdG9tRG9tYWluKSkge1xuICAgIHZhciBhcHBOYW1lID0gaG9zdC5zbGljZSgwLCAtKGN1c3RvbURvbWFpbi5sZW5ndGggKyAxKSk7XG4gICAgcmVxdWVzdC51cmkgPSAnLycgKyBhcHBOYW1lICsgcmVxdWVzdC51cmk7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG4gICAgICAgICAgYCksXG4gICAgICAgICAgZnVuY3Rpb25OYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tc3ViZG9tYWluLXJld3JpdGVgLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBBUEkgR2F0ZXdheSBvcmlnaW5cbiAgICAgICAgY29uc3QgYXBpRG9tYWluTmFtZSA9IGNkay5Gbi5zZWxlY3QoXG4gICAgICAgICAgMixcbiAgICAgICAgICBjZGsuRm4uc3BsaXQoXCIvXCIsIGh0dHBBcGkuYXBpRW5kcG9pbnQpXG4gICAgICAgICk7XG5cbiAgICAgICAgY29uc3QgZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKFxuICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgXCJGcm9udGVuZERpc3RyaWJ1dGlvblwiLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGNlcnRpZmljYXRlOiBjbG91ZGZyb250Q2VydGlmaWNhdGUsXG4gICAgICAgICAgICBkb21haW5OYW1lczogW2AqLiR7Y3VzdG9tRG9tYWlufWBdLFxuICAgICAgICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XG4gICAgICAgICAgICAgIG9yaWdpbjogbmV3IG9yaWdpbnMuSHR0cE9yaWdpbihhcGlEb21haW5OYW1lLCB7XG4gICAgICAgICAgICAgICAgcHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUHJvdG9jb2xQb2xpY3kuSFRUUFNfT05MWSxcbiAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OlxuICAgICAgICAgICAgICAgIGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRCxcbiAgICAgICAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeShcbiAgICAgICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgICAgIFwiRnJvbnRlbmRPcmlnaW5Qb2xpY3lcIixcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBjb29raWVCZWhhdmlvcjpcbiAgICAgICAgICAgICAgICAgICAgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3IuYWxsb3dMaXN0KFxuICAgICAgICAgICAgICAgICAgICAgIFwiaGVyZXlhX2lkX3Rva2VuXCIsXG4gICAgICAgICAgICAgICAgICAgICAgXCJoZXJleWFfYWdlbnRcIlxuICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgLy8gQmFzZSBzZXQgKyBgYWRkaXRpb25hbEZvcndhcmRlZEhlYWRlcnNgIChidWlsdCBhdCB0aGUgdG9wIG9mXG4gICAgICAgICAgICAgICAgICAvLyB0aGUgY29uc3RydWN0b3IpLiBDbG91ZEZyb250IHN0cmlwcyBhbnkgaGVhZGVyIG5vdCB3aGl0ZWxpc3RlZFxuICAgICAgICAgICAgICAgICAgLy8gaGVyZSwgc28gY3VzdG9tIGF1dGgvd2ViaG9vayBoZWFkZXJzICh4LWZvcndhcmRlZC1ob3N0IGZvclxuICAgICAgICAgICAgICAgICAgLy8gdmFuaXR5LWhvc3QgbG9naW4gY29va2llczsgWC1UZWxlZ3JhbS1Cb3QtQXBpLVNlY3JldC1Ub2tlbiBmb3JcbiAgICAgICAgICAgICAgICAgIC8vIHRoZSBUZWxlZ3JhbSB3ZWJob29rOyBYLURpbGF5YS1BZ2VudC1Ub2tlbiBmb3IgdGhlIGFnZW50IHBvbGwpXG4gICAgICAgICAgICAgICAgICAvLyBtdXN0IGFwcGVhciBpbiB0aGlzIGxpc3Qgb3IgdGhlIG9yaWdpbiBuZXZlciBzZWVzIHRoZW0uXG4gICAgICAgICAgICAgICAgICBoZWFkZXJCZWhhdmlvcjpcbiAgICAgICAgICAgICAgICAgICAgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0SGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KFxuICAgICAgICAgICAgICAgICAgICAgIC4uLmZyb250ZW5kRm9yd2FyZEhlYWRlcnNcbiAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6XG4gICAgICAgICAgICAgICAgICAgIGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uOiBjZkZ1bmN0aW9uLFxuICAgICAgICAgICAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVFVRVNULFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH1cbiAgICAgICAgKTtcblxuICAgICAgICAvLyBSb3V0ZTUzIHdpbGRjYXJkIC0+IENsb3VkRnJvbnRcbiAgICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIldpbGRjYXJkQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICAgIHpvbmU6IGhvc3RlZFpvbmUsXG4gICAgICAgICAgcmVjb3JkTmFtZTogYCouJHtjdXN0b21Eb21haW59YCxcbiAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhcbiAgICAgICAgICAgIG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQoZGlzdHJpYnV0aW9uKVxuICAgICAgICAgICksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiRnJvbnRlbmREaXN0cmlidXRpb25Eb21haW5cIiwge1xuICAgICAgICAgIHZhbHVlOiBkaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uRG9tYWluTmFtZSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgLy8gQ3VzdG9tLWRvbWFpbiBzdXBwb3J0IHdpcmluZ1xuICAgICAgICAvL1xuICAgICAgICAvLyBUaGUgb3JnIExhbWJkYSBleHBvc2VzIE1DUCB0b29scyB0aGF0IHN3YXAgdGhlIGRpc3RyaWJ1dGlvbidzXG4gICAgICAgIC8vIFZpZXdlckNlcnRpZmljYXRlIGluLXBsYWNlIHdoZW4gdXNlcnMgcmVxdWVzdCB2YW5pdHkgZG9tYWlucy4gV2U6XG4gICAgICAgIC8vICAgMS4gU2VlZCBhbiBTU00gcGFyYW0gd2l0aCB0aGUgYm9vdHN0cmFwIHdpbGRjYXJkIGNlcnQgQVJOIG9uXG4gICAgICAgIC8vICAgICAgZmlyc3QgZGVwbG95IChvblVwZGF0ZSBpcyBhIG5vLW9wIOKGkiBzdWJzZXF1ZW50IGRlcGxveXMgZG9uJ3RcbiAgICAgICAgLy8gICAgICBvdmVyd3JpdGUgdGhlIExhbWJkYSdzIGxpdmUgY2VydCBBUk4pLlxuICAgICAgICAvLyAgIDIuIEdyYW50IHRoZSBvcmcgTGFtYmRhIEFDTSAodGFnLXNjb3BlZCkgKyBDbG91ZEZyb250IChBUk4tc2NvcGVkKVxuICAgICAgICAvLyAgICAgICsgU1NNIChwYXRoLXNjb3BlZCkgcGVybWlzc2lvbnMuXG4gICAgICAgIC8vICAgMy4gUGFzcyBkaXN0cmlidXRpb24gKyBmdW5jdGlvbiBpZGVudGlmaWVycyArIFNTTSBwYXRoIHRocm91Z2ggZW52LlxuICAgICAgICAvL1xuICAgICAgICAvLyBOT1RFIG9uIGRyaWZ0OiBpZiBhIGZ1dHVyZSBDREsgc3RhY2sgY2hhbmdlIHRvdWNoZXMgdGhlIERpc3RyaWJ1dGlvblxuICAgICAgICAvLyBvciB0aGUgQ0YgZnVuY3Rpb24sIENsb3VkRm9ybWF0aW9uIHdpbGwgcmUtc2VuZCBDREsncyBpbmxpbmUgY29uZmlnXG4gICAgICAgIC8vIGFuZCBvdmVyd3JpdGUgdGhlIExhbWJkYSdzIGxpdmUgc3RhdGUuIFJlbWVkaWF0aW9uIGlzIHRvIHJlLXJ1blxuICAgICAgICAvLyBgY2hlY2stY3VzdG9tLWRvbWFpbnNgIGFmdGVyIHRoZSBzdGFjayB1cGRhdGUuXG4gICAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAgICAgY29uc3Qgdmlld2VyQ2VydFNzbVBhcmFtTmFtZSA9IGAvaGVyZXlhLyR7b3JnYW5pemF0aW9uSWR9L3ZpZXdlci1jZXJ0LWFybmA7XG4gICAgICAgIGNvbnN0IHZpZXdlckNlcnRTc21QYXJhbUFybiA9IGBhcm46YXdzOnNzbToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06cGFyYW1ldGVyJHt2aWV3ZXJDZXJ0U3NtUGFyYW1OYW1lfWA7XG5cbiAgICAgICAgY29uc3Qgc2VlZFZpZXdlckNlcnRBcm4gPSBuZXcgY3IuQXdzQ3VzdG9tUmVzb3VyY2UoXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICBcIlZpZXdlckNlcnRTc21TZWVkXCIsXG4gICAgICAgICAge1xuICAgICAgICAgICAgb25DcmVhdGU6IHtcbiAgICAgICAgICAgICAgc2VydmljZTogXCJTU01cIixcbiAgICAgICAgICAgICAgYWN0aW9uOiBcIlB1dFBhcmFtZXRlclwiLFxuICAgICAgICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgTmFtZTogdmlld2VyQ2VydFNzbVBhcmFtTmFtZSxcbiAgICAgICAgICAgICAgICBWYWx1ZTogY2xvdWRmcm9udENlcnRpZmljYXRlLmNlcnRpZmljYXRlQXJuLFxuICAgICAgICAgICAgICAgIFR5cGU6IFwiU3RyaW5nXCIsXG4gICAgICAgICAgICAgICAgT3ZlcndyaXRlOiBmYWxzZSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoXG4gICAgICAgICAgICAgICAgYHZpZXdlci1jZXJ0LXNlZWQtJHtvcmdhbml6YXRpb25JZH1gXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgIGlnbm9yZUVycm9yQ29kZXNNYXRjaGluZzogXCJQYXJhbWV0ZXJBbHJlYWR5RXhpc3RzXCIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgb25VcGRhdGU6IHtcbiAgICAgICAgICAgICAgc2VydmljZTogXCJTU01cIixcbiAgICAgICAgICAgICAgYWN0aW9uOiBcIkdldFBhcmFtZXRlclwiLFxuICAgICAgICAgICAgICBwYXJhbWV0ZXJzOiB7IE5hbWU6IHZpZXdlckNlcnRTc21QYXJhbU5hbWUgfSxcbiAgICAgICAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoXG4gICAgICAgICAgICAgICAgYHZpZXdlci1jZXJ0LXNlZWQtJHtvcmdhbml6YXRpb25JZH1gXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgIGlnbm9yZUVycm9yQ29kZXNNYXRjaGluZzogXCJQYXJhbWV0ZXJOb3RGb3VuZFwiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIG9uRGVsZXRlOiB7XG4gICAgICAgICAgICAgIHNlcnZpY2U6IFwiU1NNXCIsXG4gICAgICAgICAgICAgIGFjdGlvbjogXCJEZWxldGVQYXJhbWV0ZXJcIixcbiAgICAgICAgICAgICAgcGFyYW1ldGVyczogeyBOYW1lOiB2aWV3ZXJDZXJ0U3NtUGFyYW1OYW1lIH0sXG4gICAgICAgICAgICAgIGlnbm9yZUVycm9yQ29kZXNNYXRjaGluZzogXCJQYXJhbWV0ZXJOb3RGb3VuZFwiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHBvbGljeTogY3IuQXdzQ3VzdG9tUmVzb3VyY2VQb2xpY3kuZnJvbVN0YXRlbWVudHMoW1xuICAgICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICAgXCJzc206UHV0UGFyYW1ldGVyXCIsXG4gICAgICAgICAgICAgICAgICBcInNzbTpHZXRQYXJhbWV0ZXJcIixcbiAgICAgICAgICAgICAgICAgIFwic3NtOkRlbGV0ZVBhcmFtZXRlclwiLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbdmlld2VyQ2VydFNzbVBhcmFtQXJuXSxcbiAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICBdKSxcbiAgICAgICAgICAgIGluc3RhbGxMYXRlc3RBd3NTZGs6IGZhbHNlLFxuICAgICAgICAgIH1cbiAgICAgICAgKTtcbiAgICAgICAgc2VlZFZpZXdlckNlcnRBcm4ubm9kZS5hZGREZXBlbmRlbmN5KGNsb3VkZnJvbnRDZXJ0aWZpY2F0ZSk7XG5cbiAgICAgICAgLy8gLS0tIEFDTSAodGFnLXNjb3BlZCk6IGFueSBjZXJ0IHRoZSBvcmcgTGFtYmRhIGNyZWF0ZXMgbXVzdCBiZVxuICAgICAgICAvLyAgICAgdGFnZ2VkIHdpdGggaXRzIG93biBvcmdJZDsgYWxsIG5vbi1jcmVhdGUgYWN0aW9ucyBhcmUgZ2F0ZWQgb25cbiAgICAgICAgLy8gICAgIHRoZSBzYW1lIHRhZyBtYXRjaGluZyBvbiB0aGUgcmVzb3VyY2UuIFRoaXMgcHJldmVudHMgb3JnIEEgZnJvbVxuICAgICAgICAvLyAgICAgdG91Y2hpbmcgb3JnIEIncyBjZXJ0cy5cbiAgICAgICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgXCJhY206UmVxdWVzdENlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICAgIFwiYWNtOkFkZFRhZ3NUb0NlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICAgICAgY29uZGl0aW9uczoge1xuICAgICAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAgICAgICBcImF3czpSZXF1ZXN0VGFnL2hlcmV5YTpvcmdJZFwiOiBvcmdhbml6YXRpb25JZCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgXCJGb3JBbGxWYWx1ZXM6U3RyaW5nRXF1YWxzXCI6IHtcbiAgICAgICAgICAgICAgICBcImF3czpUYWdLZXlzXCI6IFtcbiAgICAgICAgICAgICAgICAgIFwiaGVyZXlhOm9yZ0lkXCIsXG4gICAgICAgICAgICAgICAgICBcImhlcmV5YTpzY2hlbWFcIixcbiAgICAgICAgICAgICAgICAgIFwiaGVyZXlhOmRvbWFpbnNcIixcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KVxuICAgICAgICApO1xuICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICBcImFjbTpEZXNjcmliZUNlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICAgIFwiYWNtOkRlbGV0ZUNlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICAgIFwiYWNtOkxpc3RUYWdzRm9yQ2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAgICAgYGFybjphd3M6YWNtOnVzLWVhc3QtMToke3RoaXMuYWNjb3VudH06Y2VydGlmaWNhdGUvKmAsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgY29uZGl0aW9uczoge1xuICAgICAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAgICAgICBcImF3czpSZXNvdXJjZVRhZy9oZXJleWE6b3JnSWRcIjogb3JnYW5pemF0aW9uSWQsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pXG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gLS0tIENsb3VkRnJvbnQgKEFSTi1zY29wZWQpOiB0aGUgb3JnIExhbWJkYSBtYXkgb25seSB1cGRhdGUgSVRTXG4gICAgICAgIC8vICAgICBvd24gZGlzdHJpYnV0aW9uIGFuZCBmdW5jdGlvbi5cbiAgICAgICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgXCJjbG91ZGZyb250OkdldERpc3RyaWJ1dGlvblwiLFxuICAgICAgICAgICAgICBcImNsb3VkZnJvbnQ6R2V0RGlzdHJpYnV0aW9uQ29uZmlnXCIsXG4gICAgICAgICAgICAgIFwiY2xvdWRmcm9udDpVcGRhdGVEaXN0cmlidXRpb25cIixcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAgICAgYGFybjphd3M6Y2xvdWRmcm9udDo6JHt0aGlzLmFjY291bnR9OmRpc3RyaWJ1dGlvbi8ke2Rpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25JZH1gLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9KVxuICAgICAgICApO1xuICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICBcImNsb3VkZnJvbnQ6R2V0RnVuY3Rpb25cIixcbiAgICAgICAgICAgICAgXCJjbG91ZGZyb250OkRlc2NyaWJlRnVuY3Rpb25cIixcbiAgICAgICAgICAgICAgXCJjbG91ZGZyb250OlVwZGF0ZUZ1bmN0aW9uXCIsXG4gICAgICAgICAgICAgIFwiY2xvdWRmcm9udDpQdWJsaXNoRnVuY3Rpb25cIixcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAgICAgYGFybjphd3M6Y2xvdWRmcm9udDo6JHt0aGlzLmFjY291bnR9OmZ1bmN0aW9uLyR7Y2ZGdW5jdGlvbi5mdW5jdGlvbk5hbWV9YCxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSlcbiAgICAgICAgKTtcblxuICAgICAgICAvLyAtLS0gU1NNIChwYXRoLXNjb3BlZCk6IHdyaXRlIHRoZSBjZXJ0IEFSTiBvbiBzd2FwLlxuICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1wic3NtOkdldFBhcmFtZXRlclwiLCBcInNzbTpQdXRQYXJhbWV0ZXJcIl0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFt2aWV3ZXJDZXJ0U3NtUGFyYW1Bcm5dLFxuICAgICAgICAgIH0pXG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gLS0tIEV4cG9zZSBJRHMgdG8gdGhlIG9yZyBMYW1iZGEuXG4gICAgICAgIGZuLmFkZEVudmlyb25tZW50KFxuICAgICAgICAgIFwiQ0xPVURGUk9OVF9ESVNUUklCVVRJT05fSURcIixcbiAgICAgICAgICBkaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uSWRcbiAgICAgICAgKTtcbiAgICAgICAgZm4uYWRkRW52aXJvbm1lbnQoXCJDTE9VREZST05UX0ZVTkNUSU9OX05BTUVcIiwgY2ZGdW5jdGlvbi5mdW5jdGlvbk5hbWUpO1xuICAgICAgICBmbi5hZGRFbnZpcm9ubWVudChcbiAgICAgICAgICBcIkNMT1VERlJPTlRfRE9NQUlOXCIsXG4gICAgICAgICAgZGlzdHJpYnV0aW9uLmRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVcbiAgICAgICAgKTtcbiAgICAgICAgZm4uYWRkRW52aXJvbm1lbnQoXCJWSUVXRVJfQ0VSVF9TU01fUEFSQU1cIiwgdmlld2VyQ2VydFNzbVBhcmFtTmFtZSk7XG4gICAgICAgIGZuLm5vZGUuYWRkRGVwZW5kZW5jeShzZWVkVmlld2VyQ2VydEFybik7XG4gICAgICB9XG5cbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiU2VydmljZVVybFwiLCB7XG4gICAgICAgIHZhbHVlOiBgaHR0cHM6Ly8ke2N1c3RvbURvbWFpbn1gLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiU2VydmljZVVybFwiLCB7XG4gICAgICAgIHZhbHVlOiBodHRwQXBpLmFwaUVuZHBvaW50LFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3REb21haW5ab25lKFxuICBjdXN0b21Eb21haW46IHN0cmluZyB8IHVuZGVmaW5lZFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFjdXN0b21Eb21haW4pIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHBhcnRzID0gY3VzdG9tRG9tYWluLnNwbGl0KFwiLlwiKTtcbiAgaWYgKHBhcnRzLmxlbmd0aCA8IDIpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgZG9tYWluIG5hbWU6IFwiICsgY3VzdG9tRG9tYWluKTtcbiAgcmV0dXJuIHBhcnRzLmxlbmd0aCA9PT0gMiA/IGN1c3RvbURvbWFpbiA6IHBhcnRzLnNsaWNlKDEpLmpvaW4oXCIuXCIpO1xufVxuIl19