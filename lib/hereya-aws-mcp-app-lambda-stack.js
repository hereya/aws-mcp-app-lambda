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
                            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList("Content-Type", "Accept-Language", 
                            // The subdomain-rewrite viewer-request CF function copies
                            // the viewer Host into x-forwarded-host so the auth Lambda
                            // can scope the session cookie's Domain attribute to the
                            // host the user actually typed (including custom vanity
                            // domains). CloudFront strips headers added by viewer-
                            // request functions before forwarding to origin unless
                            // they're explicitly whitelisted here — without this
                            // entry, vanity-host logins set a cookie scoped to the
                            // default customDomain and the browser silently rejects
                            // it (RFC 6265 domain mismatch), breaking login.
                            "x-forwarded-host", 
                            // Inbound webhook providers carry a shared secret in a
                            // custom header that the per-app webhook handler verifies.
                            // CloudFront whitelists headers forwarded to origin, so
                            // these must be listed or they're stripped (causing the
                            // handler to 401 every delivery). Telegram uses
                            // X-Telegram-Bot-Api-Secret-Token.
                            "X-Telegram-Bot-Api-Secret-Token"),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGVyZXlhLWF3cy1tY3AtYXBwLWxhbWJkYS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImhlcmV5YS1hd3MtbWNwLWFwcC1sYW1iZGEtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsc0RBQXdDO0FBQ3hDLDJDQUErQztBQUMvQywrREFBaUQ7QUFDakQsc0VBQXdEO0FBQ3hELHdGQUEwRTtBQUMxRSx3RUFBMEQ7QUFDMUQseURBQTJDO0FBQzNDLGlFQUFtRDtBQUNuRCx5RUFBMkQ7QUFDM0Qsd0VBQTBEO0FBQzFELHNGQUF3RTtBQUN4RSx1RUFBeUQ7QUFDekQsNEVBQThEO0FBQzlELGlFQUFtRDtBQUNuRCxtRUFBcUQ7QUFFckQsMkNBQTZCO0FBRTdCLE1BQWEsMEJBQTJCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDdkQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLG9CQUFvQixHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsc0JBQXNCLENBQUMsQ0FBQztRQUNqRSxJQUFJLENBQUMsb0JBQW9CLEVBQUUsQ0FBQztZQUMxQixNQUFNLElBQUksS0FBSyxDQUFDLHVEQUF1RCxDQUFDLENBQUM7UUFDM0UsQ0FBQztRQUVELE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztRQUNyRCxJQUFJLENBQUMsY0FBYyxFQUFFLENBQUM7WUFDcEIsTUFBTSxJQUFJLEtBQUssQ0FBQyxpREFBaUQsQ0FBQyxDQUFDO1FBQ3JFLENBQUM7UUFFRCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixDQUFDLENBQUM7UUFDckQsSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO1lBQ3BCLE1B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aENDO0FBRUQsU0FBUyxpQkFBaUIsQ0FDeEIsWUFBZ0M7SUFFaEMsSUFBSSxDQUFDLFlBQVk7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUNwQyxNQUFNLEtBQUssR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3RDLElBQUksS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyx1QkFBdUIsR0FBRyxZQUFZLENBQUMsQ0FBQztJQUM5RSxPQUFPLEtBQUssQ0FBQyxNQUFNLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ3RFLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSBcImF3cy1jZGstbGliL2NvcmVcIjtcbmltcG9ydCB7IFNlY3JldFZhbHVlIH0gZnJvbSBcImF3cy1jZGstbGliL2NvcmVcIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgaW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgc2VjcmV0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgKiBhcyB0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGF1dGhvcml6ZXJzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWF1dGhvcml6ZXJzXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgY3IgZnJvbSBcImF3cy1jZGstbGliL2N1c3RvbS1yZXNvdXJjZXNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gXCJwYXRoXCI7XG5cbmV4cG9ydCBjbGFzcyBIZXJleWFBd3NNY3BBcHBMYW1iZGFTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIGNvbnN0IGhlcmV5YVByb2plY3RSb290RGlyID0gcHJvY2Vzcy5lbnZbXCJoZXJleWFQcm9qZWN0Um9vdERpclwiXTtcbiAgICBpZiAoIWhlcmV5YVByb2plY3RSb290RGlyKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJoZXJleWFQcm9qZWN0Um9vdERpciBlbnZpcm9ubWVudCB2YXJpYWJsZSBpcyByZXF1aXJlZFwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBvYXV0aFNlcnZlclVybCA9IHByb2Nlc3MuZW52W1wib2F1dGhTZXJ2ZXJVcmxcIl07XG4gICAgaWYgKCFvYXV0aFNlcnZlclVybCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwib2F1dGhTZXJ2ZXJVcmwgZW52aXJvbm1lbnQgdmFyaWFibGUgaXMgcmVxdWlyZWRcIik7XG4gICAgfVxuXG4gICAgY29uc3Qgb3JnYW5pemF0aW9uSWQgPSBwcm9jZXNzLmVudltcIm9yZ2FuaXphdGlvbklkXCJdO1xuICAgIGlmICghb3JnYW5pemF0aW9uSWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIm9yZ2FuaXphdGlvbklkIGVudmlyb25tZW50IHZhcmlhYmxlIGlzIHJlcXVpcmVkXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IG1lbW9yeVNpemUgPSBwcm9jZXNzLmVudltcIm1lbW9yeVNpemVcIl1cbiAgICAgID8gcGFyc2VJbnQocHJvY2Vzcy5lbnZbXCJtZW1vcnlTaXplXCJdKVxuICAgICAgOiAyNTY7XG4gICAgY29uc3QgdGltZW91dCA9IHByb2Nlc3MuZW52W1widGltZW91dFwiXVxuICAgICAgPyBwYXJzZUludChwcm9jZXNzLmVudltcInRpbWVvdXRcIl0pXG4gICAgICA6IDMwO1xuICAgIGNvbnN0IGhhbmRsZXJOYW1lID0gcHJvY2Vzcy5lbnZbXCJoYW5kbGVyXCJdID8/IFwiaGFuZGxlci5oYW5kbGVyXCI7XG4gICAgY29uc3QgY3VzdG9tRG9tYWluID0gcHJvY2Vzcy5lbnZbXCJjdXN0b21Eb21haW5cIl07XG4gICAgY29uc3QgY3VzdG9tRG9tYWluWm9uZSA9XG4gICAgICBwcm9jZXNzLmVudltcImN1c3RvbURvbWFpblpvbmVcIl0gPz8gZXh0cmFjdERvbWFpblpvbmUoY3VzdG9tRG9tYWluKTtcbiAgICBjb25zdCB3aWxkY2FyZENlcnRpZmljYXRlQXJuID0gcHJvY2Vzcy5lbnZbXCJ3aWxkY2FyZENlcnRpZmljYXRlQXJuXCJdO1xuXG4gICAgLy8gUGFyc2UgaGVyZXlhUHJvamVjdEVudlxuICAgIGNvbnN0IGVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IEpTT04ucGFyc2UoXG4gICAgICBwcm9jZXNzLmVudltcImhlcmV5YVByb2plY3RFbnZcIl0gPz8gXCJ7fVwiXG4gICAgKTtcblxuICAgIC8vIFNlcGFyYXRlIElBTSBwb2xpY3kgZW52IHZhcnNcbiAgICBjb25zdCBwb2xpY3lFbnYgPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICBPYmplY3QuZW50cmllcyhlbnYpLmZpbHRlcihcbiAgICAgICAgKFtrZXldKSA9PiBrZXkuc3RhcnRzV2l0aChcIklBTV9QT0xJQ1lfXCIpIHx8IGtleS5zdGFydHNXaXRoKFwiaWFtUG9saWN5XCIpXG4gICAgICApXG4gICAgKTtcblxuICAgIGNvbnN0IG5vblBvbGljeUVudiA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIE9iamVjdC5lbnRyaWVzKGVudikuZmlsdGVyKFxuICAgICAgICAoW2tleV0pID0+XG4gICAgICAgICAgIWtleS5zdGFydHNXaXRoKFwiSUFNX1BPTElDWV9cIikgJiYgIWtleS5zdGFydHNXaXRoKFwiaWFtUG9saWN5XCIpXG4gICAgICApXG4gICAgKTtcblxuICAgIC8vIFNlcGFyYXRlIHNlY3JldCBlbnYgdmFycyAoc2VjcmV0Oi8vIHByZWZpeClcbiAgICBjb25zdCBzZWNyZXRFbnZFbnRyaWVzID0gT2JqZWN0LmVudHJpZXMobm9uUG9saWN5RW52KVxuICAgICAgLmZpbHRlcigoWywgdmFsdWVdKSA9PiAodmFsdWUgYXMgc3RyaW5nKS5zdGFydHNXaXRoKFwic2VjcmV0Oi8vXCIpKVxuICAgICAgLm1hcCgoW2tleSwgdmFsdWVdKSA9PiB7XG4gICAgICAgIGNvbnN0IHBsYWluVmFsdWUgPSAodmFsdWUgYXMgc3RyaW5nKS5zcGxpdChcInNlY3JldDovL1wiKVsxXTtcbiAgICAgICAgY29uc3Qgc2VjcmV0TmFtZSA9IGAvJHt0aGlzLnN0YWNrTmFtZX0vJHtrZXl9YDtcbiAgICAgICAgY29uc3Qgc2VjcmV0ID0gbmV3IHNlY3JldHMuU2VjcmV0KHRoaXMsIGtleSwge1xuICAgICAgICAgIHNlY3JldE5hbWUsXG4gICAgICAgICAgc2VjcmV0U3RyaW5nVmFsdWU6IFNlY3JldFZhbHVlLnVuc2FmZVBsYWluVGV4dChwbGFpblZhbHVlKSxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGtleSwgc2VjcmV0LCBzZWNyZXROYW1lIH07XG4gICAgICB9KTtcblxuICAgIGNvbnN0IHBsYWluRW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgT2JqZWN0LmVudHJpZXMobm9uUG9saWN5RW52KS5maWx0ZXIoXG4gICAgICAgIChbLCB2YWx1ZV0pID0+ICEodmFsdWUgYXMgc3RyaW5nKS5zdGFydHNXaXRoKFwic2VjcmV0Oi8vXCIpXG4gICAgICApXG4gICAgKTtcblxuXG4gICAgLy8gQ29nbml0byBjb25maWcgKGZyb20gYXdzL2NvZ25pdG8gcGFja2FnZSBvdXRwdXRzIHZpYSBoZXJleWFQcm9qZWN0RW52KVxuICAgIGNvbnN0IGNvZ25pdG9Vc2VyUG9vbElkID0gcGxhaW5FbnZbXCJ1c2VyUG9vbElkXCJdID8/IG5vblBvbGljeUVudltcInVzZXJQb29sSWRcIl07XG4gICAgY29uc3QgY29nbml0b0NsaWVudElkID0gcGxhaW5FbnZbXCJ1c2VyUG9vbENsaWVudElkXCJdID8/IG5vblBvbGljeUVudltcInVzZXJQb29sQ2xpZW50SWRcIl07XG4gICAgY29uc3QgY29nbml0b1JlZ2lvbiA9IHBsYWluRW52W1wiYXdzQ29nbml0b1JlZ2lvblwiXSA/PyBub25Qb2xpY3lFbnZbXCJhd3NDb2duaXRvUmVnaW9uXCJdID8/IHByb2Nlc3MuZW52W1wiQ0RLX0RFRkFVTFRfUkVHSU9OXCJdID8/IFwidXMtZWFzdC0xXCI7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIExhbWJkYSBuYW1pbmcgcHJlZml4IGZvciBwZXItYXBwIExhbWJkYXMgKGRlcml2ZWQgZnJvbSBjdXN0b21Eb21haW4pXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IG9yZ1ByZWZpeCA9IGN1c3RvbURvbWFpblxuICAgICAgPyBjdXN0b21Eb21haW4uc3BsaXQoXCIuXCIpWzBdXG4gICAgICA6IHRoaXMuc3RhY2tOYW1lLnN1YnN0cmluZygwLCAyMCk7XG4gICAgY29uc3QgYXBwTGFtYmRhTmFtZVByZWZpeCA9IGAke29yZ1ByZWZpeH0tYXBwLWA7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIExhbWJkYSAxOiBBcHAgSGFuZGxlciAoT3JnIExhbWJkYSDigJQgTUNQIG9ubHkpXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIFBhc3MgZGVwbG95LXRpbWUgY29uZmlnIHZhcnMgdG8gdGhlIGhhbmRsZXIgKG5vdCBpbiBoZXJleWFQcm9qZWN0RW52KVxuICAgIGlmIChjdXN0b21Eb21haW4pIHtcbiAgICAgIHBsYWluRW52W1wiY3VzdG9tRG9tYWluXCJdID0gY3VzdG9tRG9tYWluO1xuICAgIH1cblxuICAgIGNvbnN0IGZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIkhhbmRsZXJcIiwge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICBoYW5kbGVyOiBoYW5kbGVyTmFtZSxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oaGVyZXlhUHJvamVjdFJvb3REaXIsIFwiZGlzdFwiKSksXG4gICAgICBtZW1vcnlTaXplLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHModGltZW91dCksXG4gICAgICBlbnZpcm9ubWVudDogcGxhaW5FbnYsXG4gICAgfSk7XG5cbiAgICAvLyBBdHRhY2ggc2VjcmV0IHJlZmVyZW5jZXMgKHNlY3JldCBuYW1lLCBub3QgdmFsdWUpIGFuZCBncmFudCByZWFkIGFjY2Vzc1xuICAgIGNvbnN0IHNlY3JldEtleXM6IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChjb25zdCB7IGtleSwgc2VjcmV0LCBzZWNyZXROYW1lIH0gb2Ygc2VjcmV0RW52RW50cmllcykge1xuICAgICAgZm4uYWRkRW52aXJvbm1lbnQoa2V5LCBzZWNyZXROYW1lKTtcbiAgICAgIHNlY3JldC5ncmFudFJlYWQoZm4pO1xuICAgICAgc2VjcmV0S2V5cy5wdXNoKGtleSk7XG4gICAgfVxuICAgIGlmIChzZWNyZXRLZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgIGZuLmFkZEVudmlyb25tZW50KFwiU0VDUkVUX0tFWVNcIiwgc2VjcmV0S2V5cy5qb2luKFwiLFwiKSk7XG4gICAgfVxuXG4gICAgLy8gQXR0YWNoIElBTSBwb2xpY2llcyBmcm9tIGRlcGVuZGVuY3kgcGFja2FnZXNcbiAgICBmb3IgKGNvbnN0IFssIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwb2xpY3lFbnYpKSB7XG4gICAgICBjb25zdCBwb2xpY3kgPSBKU09OLnBhcnNlKHZhbHVlIGFzIHN0cmluZyk7XG4gICAgICBmb3IgKGNvbnN0IHN0YXRlbWVudCBvZiBwb2xpY3kuU3RhdGVtZW50KSB7XG4gICAgICAgIGZuLmFkZFRvUm9sZVBvbGljeShpYW0uUG9saWN5U3RhdGVtZW50LmZyb21Kc29uKHN0YXRlbWVudCkpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gU2hhcmVkIElBTSBSb2xlIGZvciBwZXItYXBwIExhbWJkYXNcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3QgYXBwTGFtYmRhUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCBcIkFwcExhbWJkYVJvbGVcIiwge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJsYW1iZGEuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tTWFuYWdlZFBvbGljeUFybihcbiAgICAgICAgICB0aGlzLFxuICAgICAgICAgIFwiQXBwTGFtYmRhQmFzaWNFeGVjXCIsXG4gICAgICAgICAgXCJhcm46YXdzOmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlXCJcbiAgICAgICAgKSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyBBcHBseSBzYW1lIElBTSBwb2xpY2llcyBmcm9tIGRlcGVuZGVuY3kgcGFja2FnZXMgKEF1cm9yYSwgUzMsIGV0Yy4pXG4gICAgZm9yIChjb25zdCBbLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocG9saWN5RW52KSkge1xuICAgICAgY29uc3QgcG9saWN5ID0gSlNPTi5wYXJzZSh2YWx1ZSBhcyBzdHJpbmcpO1xuICAgICAgZm9yIChjb25zdCBzdGF0ZW1lbnQgb2YgcG9saWN5LlN0YXRlbWVudCkge1xuICAgICAgICBhcHBMYW1iZGFSb2xlLmFkZFRvUG9saWN5KGlhbS5Qb2xpY3lTdGF0ZW1lbnQuZnJvbUpzb24oc3RhdGVtZW50KSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBMYW1iZGEgTGF5ZXIgZm9yIHBlci1hcHAgcnVudGltZSB1dGlsaXRpZXNcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3QgcnVudGltZUxheWVyID0gbmV3IGxhbWJkYS5MYXllclZlcnNpb24odGhpcywgXCJBcHBSdW50aW1lTGF5ZXJcIiwge1xuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KFxuICAgICAgICBwYXRoLmpvaW4oaGVyZXlhUHJvamVjdFJvb3REaXIsIFwiZGlzdFwiLCBcImxheWVyXCIpXG4gICAgICApLFxuICAgICAgY29tcGF0aWJsZVJ1bnRpbWVzOiBbbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1hdLFxuICAgICAgZGVzY3JpcHRpb246IFwiSGVyZXlhIHJ1bnRpbWUgKGRiLCBzdG9yYWdlKSBmb3IgcGVyLWFwcCBMYW1iZGFzXCIsXG4gICAgfSk7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIFBlci1hcHAgYXV0aDogc2hhcmVkIG11bHRpLXRlbmFudCBDb2duaXRvIHRyaWdnZXJzICsgT1RQIHRhYmxlLlxuICAgIC8vXG4gICAgLy8gYGVuYWJsZS1hdXRoYCBwcm92aXNpb25zIGEgZGVkaWNhdGVkIENvZ25pdG8gdXNlciBwb29sIHBlciBhcHAuIEFsbFxuICAgIC8vIHBvb2xzIGFjcm9zcyB0aGUgb3JnIGFyZSB3aXJlZCB0byB0aGUgc2FtZSA0IGNoYWxsZW5nZSB0cmlnZ2VyIExhbWJkYXNcbiAgICAvLyBkZWNsYXJlZCBoZXJlIOKAlCB0aGUgdHJpZ2dlcnMgYXJlIHBvb2wtYWdub3N0aWMgKHRoZXkgcmVhZFxuICAgIC8vIGV2ZW50LnVzZXJQb29sSWQgYXQgcnVudGltZSkuIFRoZSBPVFAgdGFibGUgaXMga2V5ZWQgYnlcbiAgICAvLyAocG9vbF9pZCwgZW1haWwpIHNvIGNvbmN1cnJlbnQgbG9naW5zIGFjcm9zcyBwb29scyBjYW4ndCBjb2xsaWRlLlxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBjb25zdCBvdHBUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIkFwcEF1dGhPdHBUYWJsZVwiLCB7XG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogXCJwb29sX2lkXCIsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogXCJlbWFpbFwiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IFwidHRsXCIsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgY29uc3QgdHJpZ2dlckVudiA9IHsgT1RQX1RBQkxFX05BTUU6IG90cFRhYmxlLnRhYmxlTmFtZSB9O1xuICAgIGNvbnN0IG1ha2VUcmlnZ2VyID0gKGlkOiBzdHJpbmcsIGRpcjogc3RyaW5nKSA9PlxuICAgICAgbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBpZCwge1xuICAgICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWCxcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcbiAgICAgICAgICBwYXRoLmpvaW4oX19kaXJuYW1lLCBcImNvZ25pdG8tdHJpZ2dlcnNcIiwgZGlyKVxuICAgICAgICApLFxuICAgICAgICBtZW1vcnlTaXplOiAxMjgsXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEwKSxcbiAgICAgICAgZW52aXJvbm1lbnQ6IHRyaWdnZXJFbnYsXG4gICAgICB9KTtcblxuICAgIGNvbnN0IHByZVNpZ25VcEZuID0gbWFrZVRyaWdnZXIoXCJQcmVTaWduVXBUcmlnZ2VyXCIsIFwicHJlLXNpZ24tdXBcIik7XG4gICAgY29uc3QgZGVmaW5lQ2hhbGxlbmdlRm4gPSBtYWtlVHJpZ2dlcihcbiAgICAgIFwiRGVmaW5lQXV0aENoYWxsZW5nZVRyaWdnZXJcIixcbiAgICAgIFwiZGVmaW5lLWF1dGgtY2hhbGxlbmdlXCJcbiAgICApO1xuICAgIGNvbnN0IGNyZWF0ZUNoYWxsZW5nZUZuID0gbWFrZVRyaWdnZXIoXG4gICAgICBcIkNyZWF0ZUF1dGhDaGFsbGVuZ2VUcmlnZ2VyXCIsXG4gICAgICBcImNyZWF0ZS1hdXRoLWNoYWxsZW5nZVwiXG4gICAgKTtcbiAgICBjb25zdCB2ZXJpZnlDaGFsbGVuZ2VGbiA9IG1ha2VUcmlnZ2VyKFxuICAgICAgXCJWZXJpZnlBdXRoQ2hhbGxlbmdlVHJpZ2dlclwiLFxuICAgICAgXCJ2ZXJpZnktYXV0aC1jaGFsbGVuZ2VcIlxuICAgICk7XG5cbiAgICBvdHBUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoY3JlYXRlQ2hhbGxlbmdlRm4pO1xuICAgIG90cFRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YSh2ZXJpZnlDaGFsbGVuZ2VGbik7XG5cbiAgICAvLyBWZXJpZnkgdHJpZ2dlciBhbHNvIHVwZGF0ZXMgdGhlIENvZ25pdG8gdXNlciBhdHRyaWJ1dGUgYGVtYWlsX3ZlcmlmaWVkYC5cbiAgICAvLyBTY29waW5nIHRvIHJlc291cmNlPVwiKlwiIGJlY2F1c2UgcGVyLWFwcCBwb29scyBhcmUgY3JlYXRlZCBhdCBydW50aW1lIGJ5XG4gICAgLy8gdGhlIG9yZyBMYW1iZGEg4oCUIHdlIGNhbid0IHBpbiBhIHNpbmdsZSBBUk4gYXQgc3RhY2sgZGVwbG95IHRpbWUuXG4gICAgdmVyaWZ5Q2hhbGxlbmdlRm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJjb2duaXRvLWlkcDpBZG1pblVwZGF0ZVVzZXJBdHRyaWJ1dGVzXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICBjb25zdCB0cmlnZ2VyQXJucyA9IFtcbiAgICAgIHByZVNpZ25VcEZuLmZ1bmN0aW9uQXJuLFxuICAgICAgZGVmaW5lQ2hhbGxlbmdlRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBjcmVhdGVDaGFsbGVuZ2VGbi5mdW5jdGlvbkFybixcbiAgICAgIHZlcmlmeUNoYWxsZW5nZUZuLmZ1bmN0aW9uQXJuLFxuICAgIF07XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIE1DUCBPQXV0aCBBdXRob3JpemVyIExhbWJkYVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBjb25zdCBhdXRob3JpemVyRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiQXV0aG9yaXplckhhbmRsZXJcIiwge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCBcImF1dGhvcml6ZXJcIikpLFxuICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgT0FVVEhfU0VSVkVSX1VSTDogb2F1dGhTZXJ2ZXJVcmwsXG4gICAgICAgIEJPVU5EX09SR19JRDogb3JnYW5pemF0aW9uSWQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgaHR0cEF1dGhvcml6ZXIgPSBuZXcgYXV0aG9yaXplcnMuSHR0cExhbWJkYUF1dGhvcml6ZXIoXG4gICAgICBcIkhlcmV5YUF1dGhvcml6ZXJcIixcbiAgICAgIGF1dGhvcml6ZXJGbixcbiAgICAgIHtcbiAgICAgICAgcmVzcG9uc2VUeXBlczogW2F1dGhvcml6ZXJzLkh0dHBMYW1iZGFSZXNwb25zZVR5cGUuU0lNUExFXSxcbiAgICAgICAgcmVzdWx0c0NhY2hlVHRsOiBjZGsuRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBIVFRQIEFQSVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBjb25zdCBodHRwQXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkh0dHBBcGlcIiwge1xuICAgICAgYXBpTmFtZTogdGhpcy5zdGFja05hbWUsXG4gICAgfSk7XG5cbiAgICBjb25zdCBsYW1iZGFJbnRlZ3JhdGlvbiA9IG5ldyBpbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgXCJMYW1iZGFJbnRlZ3JhdGlvblwiLFxuICAgICAgZm5cbiAgICApO1xuXG4gICAgLy8gQ29tcHV0ZSBzZXJ2aWNlIFVSTCBmb3IgUFJNIChjdXN0b20gZG9tYWluIG9yIEFQSSBlbmRwb2ludClcbiAgICBjb25zdCBzZXJ2aWNlVXJsID0gY3VzdG9tRG9tYWluXG4gICAgICA/IGBodHRwczovLyR7Y3VzdG9tRG9tYWlufWBcbiAgICAgIDogaHR0cEFwaS5hcGlFbmRwb2ludDtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gUHJvdGVjdGVkIFJlc291cmNlIE1ldGFkYXRhIChSRkMgOTcyOClcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3QgcHJtTGFtYmRhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIlBybUhhbmRsZXJcIiwge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoYFxuICAgICAgICBleHBvcnRzLmhhbmRsZXIgPSBhc3luYyAoKSA9PiAoe1xuICAgICAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgICAgICAgICAgIFwiQ2FjaGUtQ29udHJvbFwiOiBcInB1YmxpYywgbWF4LWFnZT0zNjAwXCIsXG4gICAgICAgICAgICBcIkFjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpblwiOiBcIipcIixcbiAgICAgICAgICB9LFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgIHJlc291cmNlOiBwcm9jZXNzLmVudi5TRVJWSUNFX1VSTCArIFwiL21jcFwiLFxuICAgICAgICAgICAgYXV0aG9yaXphdGlvbl9zZXJ2ZXJzOiBbcHJvY2Vzcy5lbnYuT0FVVEhfU0VSVkVSX1VSTCArIFwiL29hdXRoL1wiICsgcHJvY2Vzcy5lbnYuT1JHQU5JWkFUSU9OX0lEXSxcbiAgICAgICAgICAgIGJlYXJlcl9tZXRob2RzX3N1cHBvcnRlZDogW1wiaGVhZGVyXCJdLFxuICAgICAgICAgICAgc2NvcGVzX3N1cHBvcnRlZDogW1wibWNwOmFjY2Vzc1wiXSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSk7XG4gICAgICBgKSxcbiAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgU0VSVklDRV9VUkw6IHNlcnZpY2VVcmwsXG4gICAgICAgIE9BVVRIX1NFUlZFUl9VUkw6IG9hdXRoU2VydmVyVXJsLFxuICAgICAgICBPUkdBTklaQVRJT05fSUQ6IG9yZ2FuaXphdGlvbklkLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGh0dHBBcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiLy53ZWxsLWtub3duL29hdXRoLXByb3RlY3RlZC1yZXNvdXJjZVwiLFxuICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgaW50ZWdyYXRpb246IG5ldyBpbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBcIlBybUludGVncmF0aW9uXCIsXG4gICAgICAgIHBybUxhbWJkYVxuICAgICAgKSxcbiAgICB9KTtcblxuICAgIC8vIE1DUCByb3V0ZSAoZXhpc3RpbmcpXG4gICAgaHR0cEFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogXCIvbWNwXCIsXG4gICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1RdLFxuICAgICAgaW50ZWdyYXRpb246IGxhbWJkYUludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogaHR0cEF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBBbGxvdyBBUEkgR2F0ZXdheSB0byBpbnZva2UgdGhlIG9yZyBMYW1iZGEgb24gQU5ZIHJvdXRlIG9mIHRoaXMgQVBJLlxuICAgIC8vIEh0dHBMYW1iZGFJbnRlZ3JhdGlvbiBvbmx5IGdyYW50cyBhIHJvdXRlLXNwZWNpZmljIHBlcm1pc3Npb24gZm9yIC9tY3AsXG4gICAgLy8gYnV0IHRoZSBvcmcgTGFtYmRhIGNyZWF0ZXMgYWRkaXRpb25hbCByb3V0ZXMgYXQgcnVudGltZSB0aGF0IHRhcmdldFxuICAgIC8vIGl0c2VsZiAoZS5nLiBwZXItYXBwIFRlbGVncmFtIHdlYmhvb2tzIGF0IC97c2NoZW1hfS90ZWxlZ3JhbS97cHJveHkrfSkuXG4gICAgLy8gV2l0aG91dCBhbiBhcGktc2NvcGVkIHBlcm1pc3Npb24gdGhvc2Ugcm91dGVzIHJldHVybiA1MDAgKEFQSSBHYXRld2F5XG4gICAgLy8gY2Fubm90IGludm9rZSB0aGUgTGFtYmRhKSwgYW5kIHRoZSBvcmcgTGFtYmRhIGNhbm5vdCBzZWxmLWdyYW50XG4gICAgLy8gKGl0cyBsYW1iZGE6QWRkUGVybWlzc2lvbiBJQU0gaXMgc2NvcGVkIHRvIHBlci1hcHAgZnVuY3Rpb24gbmFtZXMgb25seSkuXG4gICAgZm4uYWRkUGVybWlzc2lvbihcIkh0dHBBcGlJbnZva2VBbGxcIiwge1xuICAgICAgcHJpbmNpcGFsOiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJhcGlnYXRld2F5LmFtYXpvbmF3cy5jb21cIiksXG4gICAgICBzb3VyY2VBcm46IGBhcm46YXdzOmV4ZWN1dGUtYXBpOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fToke2h0dHBBcGkuYXBpSWR9LyovKmAsXG4gICAgfSk7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIEZyb250ZW5kIEF1dGhvcml6ZXIgKyBBdXRoIExhbWJkYSAoZm9yIHBlci1hcHAgTGFtYmRhcylcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgLy8gVGhlc2UgYXJlIGNyZWF0ZWQgYXQgQ0RLIHRpbWUuIFRoZWlyIElEcyBhcmUgcGFzc2VkIHRvIHRoZSBvcmcgTGFtYmRhXG4gICAgLy8gc28gaXQgY2FuIGNyZWF0ZSBwZXItYXBwIEFQSSBHYXRld2F5IHJvdXRlcyBkeW5hbWljYWxseS5cblxuICAgIGxldCBmcm9udGVuZEF1dGhvcml6ZXJJZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGxldCBhdXRoSW50ZWdyYXRpb25JZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXG4gICAgaWYgKGNvZ25pdG9Vc2VyUG9vbElkICYmIGNvZ25pdG9DbGllbnRJZCkge1xuICAgICAgLy8gRnJvbnRlbmQgQXV0aG9yaXplciBMYW1iZGEgKG11bHRpLXRlbmFudDogcGVyLWFwcCBwb29sIGxvb2t1cCB2aWEgREIsXG4gICAgICAvLyB3aXRoIHNoYXJlZC1wb29sIGZhbGxiYWNrIGZvciBQaGFzZS1BIG1pZ3JhdGlvbikuXG4gICAgICBjb25zdCBmcm9udGVuZEF1dGhvcml6ZXJGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24oXG4gICAgICAgIHRoaXMsXG4gICAgICAgIFwiRnJvbnRlbmRBdXRob3JpemVySGFuZGxlclwiLFxuICAgICAgICB7XG4gICAgICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KFxuICAgICAgICAgICAgcGF0aC5qb2luKF9fZGlybmFtZSwgXCJmcm9udGVuZC1hdXRob3JpemVyXCIpXG4gICAgICAgICAgKSxcbiAgICAgICAgICBtZW1vcnlTaXplOiAxMjgsXG4gICAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgICAgICBDT0dOSVRPX1VTRVJfUE9PTF9JRDogY29nbml0b1VzZXJQb29sSWQsXG4gICAgICAgICAgICBDT0dOSVRPX1JFR0lPTjogY29nbml0b1JlZ2lvbixcbiAgICAgICAgICAgIGNsdXN0ZXJBcm46IHBsYWluRW52W1wiY2x1c3RlckFyblwiXSA/PyBcIlwiLFxuICAgICAgICAgICAgc2VjcmV0QXJuOiBwbGFpbkVudltcInNlY3JldEFyblwiXSA/PyBcIlwiLFxuICAgICAgICAgICAgZGF0YWJhc2VOYW1lOiBwbGFpbkVudltcImRhdGFiYXNlTmFtZVwiXSA/PyBcIlwiLFxuICAgICAgICAgIH0sXG4gICAgICAgIH1cbiAgICAgICk7XG5cbiAgICAgIC8vIEFwcGx5IEF1cm9yYSBEYXRhIEFQSSBwb2xpY2llcyBmcm9tIGRlcCBwYWNrYWdlcyBzbyB0aGUgYXV0aG9yaXplciBjYW5cbiAgICAgIC8vIFNFTEVDVCBmcm9tIHB1YmxpYy5fYXBwX2F1dGguXG4gICAgICBmb3IgKGNvbnN0IFssIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwb2xpY3lFbnYpKSB7XG4gICAgICAgIGNvbnN0IHBvbGljeSA9IEpTT04ucGFyc2UodmFsdWUgYXMgc3RyaW5nKTtcbiAgICAgICAgZm9yIChjb25zdCBzdGF0ZW1lbnQgb2YgcG9saWN5LlN0YXRlbWVudCkge1xuICAgICAgICAgIGZyb250ZW5kQXV0aG9yaXplckZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgICAgIGlhbS5Qb2xpY3lTdGF0ZW1lbnQuZnJvbUpzb24oc3RhdGVtZW50KVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gR3JhbnQgQVBJIEdhdGV3YXkgcGVybWlzc2lvbiB0byBpbnZva2UgdGhlIGZyb250ZW5kIGF1dGhvcml6ZXJcbiAgICAgIGZyb250ZW5kQXV0aG9yaXplckZuLmFkZFBlcm1pc3Npb24oXCJBcGlHd0F1dGhvcml6ZXJJbnZva2VcIiwge1xuICAgICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImFwaWdhdGV3YXkuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgICAgc291cmNlQXJuOiBgYXJuOmF3czpleGVjdXRlLWFwaToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06JHtodHRwQXBpLmFwaUlkfS8qYCxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBGcm9udGVuZCBBdXRob3JpemVyIGFzIEwxIGNvbnN0cnVjdCAodG8gZ2V0IGF1dGhvcml6ZXIgSUQpXG4gICAgICBjb25zdCBmcm9udGVuZEF1dGhvcml6ZXJDZm4gPSBuZXcgYXBpZ3d2Mi5DZm5BdXRob3JpemVyKFxuICAgICAgICB0aGlzLFxuICAgICAgICBcIkZyb250ZW5kQXV0aG9yaXplckNmblwiLFxuICAgICAgICB7XG4gICAgICAgICAgYXBpSWQ6IGh0dHBBcGkuYXBpSWQsXG4gICAgICAgICAgYXV0aG9yaXplclR5cGU6IFwiUkVRVUVTVFwiLFxuICAgICAgICAgIGF1dGhvcml6ZXJVcmk6IGBhcm46YXdzOmFwaWdhdGV3YXk6JHt0aGlzLnJlZ2lvbn06bGFtYmRhOnBhdGgvMjAxNS0wMy0zMS9mdW5jdGlvbnMvJHtmcm9udGVuZEF1dGhvcml6ZXJGbi5mdW5jdGlvbkFybn0vaW52b2NhdGlvbnNgLFxuICAgICAgICAgIGF1dGhvcml6ZXJQYXlsb2FkRm9ybWF0VmVyc2lvbjogXCIyLjBcIixcbiAgICAgICAgICBlbmFibGVTaW1wbGVSZXNwb25zZXM6IHRydWUsXG4gICAgICAgICAgYXV0aG9yaXplclJlc3VsdFR0bEluU2Vjb25kczogMCxcbiAgICAgICAgICBpZGVudGl0eVNvdXJjZTogW10gYXMgc3RyaW5nW10sIC8vIGVtcHR5ID0gYWx3YXlzIGludm9rZSAoc3VwcG9ydHMgcHVibGljIGVuZHBvaW50cylcbiAgICAgICAgICBuYW1lOiBcIkZyb250ZW5kQXV0aG9yaXplclYyXCIsXG4gICAgICAgIH1cbiAgICAgICk7XG4gICAgICBmcm9udGVuZEF1dGhvcml6ZXJJZCA9IGZyb250ZW5kQXV0aG9yaXplckNmbi5yZWY7XG5cbiAgICAgIC8vIEF1dGggTGFtYmRhIChsb2dpbi9PVFAvdmVyaWZ5L2xvZ291dCkuIE11bHRpLXRlbmFudDogZXh0cmFjdHMgYXBwIGZyb21cbiAgICAgIC8vIHBhdGgsIGxvb2tzIHVwIHBlci1hcHAgcG9vbCBjbGllbnQgKyBQb3N0bWFyayB0b2tlbiwgZmFsbHMgYmFjayB0byB0aGVcbiAgICAgIC8vIHNoYXJlZCBvcmcgcG9vbCBmb3IgdW5taWdyYXRlZCBhcHBzLlxuICAgICAgY29uc3QgYXV0aExhbWJkYUVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAgICAgQ09HTklUT19VU0VSX1BPT0xfSUQ6IGNvZ25pdG9Vc2VyUG9vbElkLFxuICAgICAgICBDT0dOSVRPX0NMSUVOVF9JRDogY29nbml0b0NsaWVudElkLFxuICAgICAgICBDT0dOSVRPX1JFR0lPTjogY29nbml0b1JlZ2lvbixcbiAgICAgICAgQ1VTVE9NX0RPTUFJTjogY3VzdG9tRG9tYWluID8/IFwiXCIsXG4gICAgICAgIEJVQ0tFVF9OQU1FOiBwbGFpbkVudltcImJ1Y2tldE5hbWVcIl0gPz8gXCJcIixcbiAgICAgICAgUzNfUFJFRklYOiBwbGFpbkVudltcInMzUHJlZml4XCJdID8/IFwiXCIsXG4gICAgICAgIE9SR0FOSVpBVElPTl9JRDogb3JnYW5pemF0aW9uSWQsXG4gICAgICAgIGNsdXN0ZXJBcm46IHBsYWluRW52W1wiY2x1c3RlckFyblwiXSA/PyBcIlwiLFxuICAgICAgICBzZWNyZXRBcm46IHBsYWluRW52W1wic2VjcmV0QXJuXCJdID8/IFwiXCIsXG4gICAgICAgIGRhdGFiYXNlTmFtZTogcGxhaW5FbnZbXCJkYXRhYmFzZU5hbWVcIl0gPz8gXCJcIixcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IGF1dGhMYW1iZGFGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJBdXRoTGFtYmRhSGFuZGxlclwiLCB7XG4gICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YLFxuICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsIFwiYXV0aC1sYW1iZGFcIikpLFxuICAgICAgICBtZW1vcnlTaXplOiAxMjgsXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDE1KSxcbiAgICAgICAgZW52aXJvbm1lbnQ6IGF1dGhMYW1iZGFFbnYsXG4gICAgICB9KTtcblxuICAgICAgLy8gR3JhbnQgQXV0aCBMYW1iZGEgYWNjZXNzIHRvIHNlY3JldHNcbiAgICAgIGNvbnN0IGF1dGhTZWNyZXRLZXlzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgZm9yIChjb25zdCB7IGtleSwgc2VjcmV0LCBzZWNyZXROYW1lIH0gb2Ygc2VjcmV0RW52RW50cmllcykge1xuICAgICAgICBhdXRoTGFtYmRhRm4uYWRkRW52aXJvbm1lbnQoa2V5LCBzZWNyZXROYW1lKTtcbiAgICAgICAgc2VjcmV0LmdyYW50UmVhZChhdXRoTGFtYmRhRm4pO1xuICAgICAgICBhdXRoU2VjcmV0S2V5cy5wdXNoKGtleSk7XG4gICAgICB9XG4gICAgICBpZiAoYXV0aFNlY3JldEtleXMubGVuZ3RoID4gMCkge1xuICAgICAgICBhdXRoTGFtYmRhRm4uYWRkRW52aXJvbm1lbnQoXCJTRUNSRVRfS0VZU1wiLCBhdXRoU2VjcmV0S2V5cy5qb2luKFwiLFwiKSk7XG4gICAgICB9XG5cbiAgICAgIC8vIEdyYW50IEF1dGggTGFtYmRhIENvZ25pdG8gcGVybWlzc2lvbnMgKyBEYXRhIEFQSSAodG8gcmVhZCBfYXBwX2F1dGgpLlxuICAgICAgZm9yIChjb25zdCBbLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocG9saWN5RW52KSkge1xuICAgICAgICBjb25zdCBwb2xpY3kgPSBKU09OLnBhcnNlKHZhbHVlIGFzIHN0cmluZyk7XG4gICAgICAgIGZvciAoY29uc3Qgc3RhdGVtZW50IG9mIHBvbGljeS5TdGF0ZW1lbnQpIHtcbiAgICAgICAgICBhdXRoTGFtYmRhRm4uYWRkVG9Sb2xlUG9saWN5KGlhbS5Qb2xpY3lTdGF0ZW1lbnQuZnJvbUpzb24oc3RhdGVtZW50KSk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gUmVhZCBwZXItYXBwIFBvc3RtYXJrIHNlcnZlciB0b2tlbiBmcm9tIFNTTSBTZWN1cmVTdHJpbmcuXG4gICAgICBjb25zdCBhcHBBdXRoU3NtQXJuID0gYGFybjphd3M6c3NtOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpwYXJhbWV0ZXIvaGVyZXlhLyR7b3JnYW5pemF0aW9uSWR9L2FwcHMvKmA7XG4gICAgICBhdXRoTGFtYmRhRm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgYWN0aW9uczogW1wic3NtOkdldFBhcmFtZXRlclwiXSxcbiAgICAgICAgICByZXNvdXJjZXM6IFthcHBBdXRoU3NtQXJuXSxcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgICBhdXRoTGFtYmRhRm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgYWN0aW9uczogW1wia21zOkRlY3J5cHRcIl0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICAgICBcImttczpWaWFTZXJ2aWNlXCI6IGBzc20uJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbWAsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgICAvLyBBbGxvdyBJbml0aWF0ZUF1dGggLyBSZXNwb25kVG9BdXRoQ2hhbGxlbmdlIGFnYWluc3QgYW55IHBlci1hcHAgcG9vbFxuICAgICAgLy8gaW4gdGhpcyBhY2NvdW50IChwb29sIEFSTnMgYXJlIGNyZWF0ZWQgYXQgcnVudGltZSBieSBlbmFibGUtYXV0aCkuXG4gICAgICBhdXRoTGFtYmRhRm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgXCJjb2duaXRvLWlkcDpJbml0aWF0ZUF1dGhcIixcbiAgICAgICAgICAgIFwiY29nbml0by1pZHA6UmVzcG9uZFRvQXV0aENoYWxsZW5nZVwiLFxuICAgICAgICAgIF0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICB9KVxuICAgICAgKTtcblxuICAgICAgLy8gR3JhbnQgQVBJIEdhdGV3YXkgcGVybWlzc2lvbiB0byBpbnZva2UgYXV0aCBMYW1iZGFcbiAgICAgIGF1dGhMYW1iZGFGbi5hZGRQZXJtaXNzaW9uKFwiQXBpR3dJbnZva2VcIiwge1xuICAgICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImFwaWdhdGV3YXkuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgICAgc291cmNlQXJuOiBgYXJuOmF3czpleGVjdXRlLWFwaToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06JHtodHRwQXBpLmFwaUlkfS8qLypgLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEF1dGggTGFtYmRhIGludGVncmF0aW9uIGFzIEwxIGNvbnN0cnVjdCAodG8gZ2V0IGludGVncmF0aW9uIElEKVxuICAgICAgY29uc3QgYXV0aEludGVncmF0aW9uQ2ZuID0gbmV3IGFwaWd3djIuQ2ZuSW50ZWdyYXRpb24oXG4gICAgICAgIHRoaXMsXG4gICAgICAgIFwiQXV0aEludGVncmF0aW9uQ2ZuXCIsXG4gICAgICAgIHtcbiAgICAgICAgICBhcGlJZDogaHR0cEFwaS5hcGlJZCxcbiAgICAgICAgICBpbnRlZ3JhdGlvblR5cGU6IFwiQVdTX1BST1hZXCIsXG4gICAgICAgICAgaW50ZWdyYXRpb25Vcmk6IGF1dGhMYW1iZGFGbi5mdW5jdGlvbkFybixcbiAgICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogXCIyLjBcIixcbiAgICAgICAgfVxuICAgICAgKTtcbiAgICAgIGF1dGhJbnRlZ3JhdGlvbklkID0gYXV0aEludGVncmF0aW9uQ2ZuLnJlZjtcbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIE9yZyBMYW1iZGE6IHBlci1hcHAgTGFtYmRhIG1hbmFnZW1lbnQgcGVybWlzc2lvbnNcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3QgYXBwTGFtYmRhQXJuUGF0dGVybiA9IGBhcm46YXdzOmxhbWJkYToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06ZnVuY3Rpb246JHthcHBMYW1iZGFOYW1lUHJlZml4fSpgO1xuXG4gICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgXCJsYW1iZGE6Q3JlYXRlRnVuY3Rpb25cIixcbiAgICAgICAgICBcImxhbWJkYTpVcGRhdGVGdW5jdGlvbkNvZGVcIixcbiAgICAgICAgICBcImxhbWJkYTpVcGRhdGVGdW5jdGlvbkNvbmZpZ3VyYXRpb25cIixcbiAgICAgICAgICBcImxhbWJkYTpHZXRGdW5jdGlvblwiLFxuICAgICAgICAgIFwibGFtYmRhOkRlbGV0ZUZ1bmN0aW9uXCIsXG4gICAgICAgICAgXCJsYW1iZGE6QWRkUGVybWlzc2lvblwiLFxuICAgICAgICAgIFwibGFtYmRhOlJlbW92ZVBlcm1pc3Npb25cIixcbiAgICAgICAgICBcImxhbWJkYTpJbnZva2VGdW5jdGlvblwiLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFthcHBMYW1iZGFBcm5QYXR0ZXJuXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIExhbWJkYSBsYXllciBhY2Nlc3MgKG5lZWRlZCB3aGVuIGNyZWF0aW5nIHBlci1hcHAgTGFtYmRhcyB3aXRoIGxheWVycylcbiAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcImxhbWJkYTpHZXRMYXllclZlcnNpb25cIl0sXG4gICAgICAgIHJlc291cmNlczogW3J1bnRpbWVMYXllci5sYXllclZlcnNpb25Bcm5dLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gQVBJIEdhdGV3YXkgcm91dGUgbWFuYWdlbWVudFxuICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwiYXBpZ2F0ZXdheTpQT1NUXCIsXG4gICAgICAgICAgXCJhcGlnYXRld2F5OkRFTEVURVwiLFxuICAgICAgICAgIFwiYXBpZ2F0ZXdheTpHRVRcIixcbiAgICAgICAgICBcImFwaWdhdGV3YXk6UEFUQ0hcIixcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgYGFybjphd3M6YXBpZ2F0ZXdheToke3RoaXMucmVnaW9ufTo6L2FwaXMvJHtodHRwQXBpLmFwaUlkfS8qYCxcbiAgICAgICAgXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIFBhc3Mgc2hhcmVkIHJvbGUgdG8gcGVyLWFwcCBMYW1iZGFzXG4gICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJpYW06UGFzc1JvbGVcIl0sXG4gICAgICAgIHJlc291cmNlczogW2FwcExhbWJkYVJvbGUucm9sZUFybl0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIFNTTSBTZWN1cmVTdHJpbmcgZm9yIHBlci1hcHAgYWdlbnQtc2Vzc2lvbiBzaWduaW5nIHNlY3JldHMuXG4gICAgLy8gUHJlZml4LWJvdW5kIHRvIC9oZXJleWEve29yZ2FuaXphdGlvbklkfS9hcHBzLyogc28gdGhlIG9yZyBMYW1iZGEgYW5kXG4gICAgLy8gcGVyLWFwcCBMYW1iZGFzIGNhbiBvbmx5IHRvdWNoIHRoZWlyIG93biBvcmcncyBzZWNyZXRzLlxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBjb25zdCBhZ2VudFNlY3JldFNzbUFybiA9IGBhcm46YXdzOnNzbToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06cGFyYW1ldGVyL2hlcmV5YS8ke29yZ2FuaXphdGlvbklkfS9hcHBzLypgO1xuXG4gICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgXCJzc206R2V0UGFyYW1ldGVyXCIsXG4gICAgICAgICAgXCJzc206R2V0UGFyYW1ldGVyc1wiLFxuICAgICAgICAgIFwic3NtOlB1dFBhcmFtZXRlclwiLFxuICAgICAgICAgIFwic3NtOkRlbGV0ZVBhcmFtZXRlclwiLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFthZ2VudFNlY3JldFNzbUFybl0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICBhcHBMYW1iZGFSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJzc206R2V0UGFyYW1ldGVyXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFthZ2VudFNlY3JldFNzbUFybl0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyBLTVMgZGVjcnlwdCBmb3IgdGhlIEFXUy1tYW5hZ2VkIFNTTSBrZXkgKFNlY3VyZVN0cmluZykuXG4gICAgLy8gU2NvcGVkIHZpYSBWaWFTZXJ2aWNlIGNvbmRpdGlvbiBzbyBpdCBvbmx5IHdvcmtzIHRocm91Z2ggU1NNLlxuICAgIGNvbnN0IHNzbUttc0RlY3J5cHQgPSBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbXCJrbXM6RGVjcnlwdFwiXSxcbiAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgU3RyaW5nRXF1YWxzOiB7XG4gICAgICAgICAgXCJrbXM6VmlhU2VydmljZVwiOiBgc3NtLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb21gLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBmbi5hZGRUb1JvbGVQb2xpY3koc3NtS21zRGVjcnlwdCk7XG4gICAgYXBwTGFtYmRhUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wia21zOkRlY3J5cHRcIl0sXG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgICAgY29uZGl0aW9uczoge1xuICAgICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICAgXCJrbXM6VmlhU2VydmljZVwiOiBgc3NtLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb21gLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyBQZXItYXBwIExhbWJkYXMgbWF5IG9wdCBpbiB0byByZWdpc3RlcmluZyB1c2VycyBzZXJ2ZXItc2lkZSB2aWEgdGhlXG4gICAgLy8gaGVyZXlhIHJ1bnRpbWUncyB1c2Vycy5hZGRVc2VyIGhlbHBlci4gU2luY2UgcGVyLWFwcCBDb2duaXRvIHBvb2xzIGFyZVxuICAgIC8vIGxvY2tlZCB0byBBbGxvd0FkbWluQ3JlYXRlVXNlck9ubHk9dHJ1ZSwgdGhlIGhlbHBlciBjYWxsc1xuICAgIC8vIEFkbWluQ3JlYXRlVXNlci4gU2NvcGUgYnkgdGhlIEhlcmV5YU9yZyB0YWcgb24gdGhlIHBvb2wgc28gb25lIG9yZydzXG4gICAgLy8gcGVyLWFwcCBMYW1iZGFzIGNhbm5vdCBjcmVhdGUgdXNlcnMgaW4gYW5vdGhlciBvcmcncyBwb29scy5cbiAgICBhcHBMYW1iZGFSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJjb2duaXRvLWlkcDpBZG1pbkNyZWF0ZVVzZXJcIl0sXG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgICAgY29uZGl0aW9uczoge1xuICAgICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICAgXCJhd3M6UmVzb3VyY2VUYWcvSGVyZXlhT3JnXCI6IG9yZ2FuaXphdGlvbklkLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIE9yZyBMYW1iZGE6IGVudmlyb25tZW50IHZhcmlhYmxlcyBmb3IgcGVyLWFwcCBMYW1iZGEgbWFuYWdlbWVudFxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBmbi5hZGRFbnZpcm9ubWVudChcIkFQUF9MQU1CREFfUk9MRV9BUk5cIiwgYXBwTGFtYmRhUm9sZS5yb2xlQXJuKTtcbiAgICBmbi5hZGRFbnZpcm9ubWVudChcIkFQUF9MQU1CREFfTkFNRV9QUkVGSVhcIiwgYXBwTGFtYmRhTmFtZVByZWZpeCk7XG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJBUFBfTEFNQkRBX0xBWUVSX0FSTlwiLCBydW50aW1lTGF5ZXIubGF5ZXJWZXJzaW9uQXJuKTtcbiAgICBmbi5hZGRFbnZpcm9ubWVudChcIkhUVFBfQVBJX0lEXCIsIGh0dHBBcGkuYXBpSWQpO1xuICAgIGZuLmFkZEVudmlyb25tZW50KFwiQVdTX0FDQ09VTlRfSURcIiwgdGhpcy5hY2NvdW50KTtcbiAgICBmbi5hZGRFbnZpcm9ubWVudChcIk9SR0FOSVpBVElPTl9JRFwiLCBvcmdhbml6YXRpb25JZCk7XG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJBR0VOVF9TRUNSRVRfU1NNX1BSRUZJWFwiLCBgL2hlcmV5YS8ke29yZ2FuaXphdGlvbklkfS9hcHBzYCk7XG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJDT0dOSVRPX1RSSUdHRVJfTEFNQkRBX0FSTlNcIiwgdHJpZ2dlckFybnMuam9pbihcIixcIikpO1xuICAgIGZuLmFkZEVudmlyb25tZW50KFwiYXdzUmVnaW9uXCIsIHRoaXMucmVnaW9uKTtcblxuICAgIGlmIChmcm9udGVuZEF1dGhvcml6ZXJJZCkge1xuICAgICAgZm4uYWRkRW52aXJvbm1lbnQoXCJGUk9OVEVORF9BVVRIT1JJWkVSX0lEXCIsIGZyb250ZW5kQXV0aG9yaXplcklkKTtcbiAgICB9XG4gICAgaWYgKGF1dGhJbnRlZ3JhdGlvbklkKSB7XG4gICAgICBmbi5hZGRFbnZpcm9ubWVudChcIkFVVEhfSU5URUdSQVRJT05fSURcIiwgYXV0aEludGVncmF0aW9uSWQpO1xuICAgIH1cblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gUGVyLWFwcCBsaWdodHdlaWdodCBzdGF0ZSB0YWJsZSAoRHluYW1vREIsIG9uLWRlbWFuZCkuIFVzZWQgZm9yIGNoZWFwXG4gICAgLy8gXCJpcyB0aGVyZSBzb21ldGhpbmcgbmV3P1wiIGZsYWdzIHNvIHBvbGxpbmcgbG9vcHMgZG9uJ3QgaGF2ZSB0byBxdWVyeVxuICAgIC8vIEF1cm9yYSAod2hpY2ggd291bGQga2VlcCBpdCBmcm9tIHNjYWxpbmcgdG8gemVybykuIE9yZy1zY29wZWQgKG9uZSB0YWJsZVxuICAgIC8vIHBlciBkZXBsb3ltZW50KTsgaXRlbXMgYXJlIGtleWVkIHBlciBhcHAgdmlhIHRoZSBwYXJ0aXRpb24ga2V5LlxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgY29uc3QgYXBwU3RhdGVUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIkFwcFN0YXRlVGFibGVcIiwge1xuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwicGtcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuICAgIGZuLmFkZEVudmlyb25tZW50KFwiQVBQX1NUQVRFX1RBQkxFXCIsIGFwcFN0YXRlVGFibGUudGFibGVOYW1lKTtcbiAgICBhcHBTdGF0ZVRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShmbik7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIE9yZyBMYW1iZGE6IHBlci1hcHAgYXV0aCBwcm92aXNpb25pbmcgcGVybWlzc2lvbnMgKGVuYWJsZS1hdXRoIHRvb2wpLlxuICAgIC8vXG4gICAgLy8gUGVyLWFwcCBDb2duaXRvIHBvb2xzICsgY2xpZW50cyBhcmUgY3JlYXRlZCBhdCBydW50aW1lIChyZXNvdXJjZXMgYXJlXG4gICAgLy8gb25seSBrbm93biBhZnRlciBDcmVhdGVVc2VyUG9vbCBzdWNjZWVkcyksIHNvIHJlc291cmNlPVwiKlwiLiBUaGUgb3JnXG4gICAgLy8gTGFtYmRhIG5lZWRzIHRvIGF0dGFjaCB0aGUgc2hhcmVkIHRyaWdnZXIgTGFtYmRhcyB0byBlYWNoIG5ldyBwb29sXG4gICAgLy8gKEFkZFBlcm1pc3Npb24pIGFuZCBjbGVhbiB0aGVtIHVwIG9uIGRyb3Atc2NoZW1hIChSZW1vdmVQZXJtaXNzaW9uKS5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpDcmVhdGVVc2VyUG9vbFwiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6RGVsZXRlVXNlclBvb2xcIixcbiAgICAgICAgICBcImNvZ25pdG8taWRwOlVwZGF0ZVVzZXJQb29sXCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpEZXNjcmliZVVzZXJQb29sXCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpMaXN0VXNlclBvb2xzXCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpDcmVhdGVVc2VyUG9vbENsaWVudFwiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6RGVsZXRlVXNlclBvb2xDbGllbnRcIixcbiAgICAgICAgICBcImNvZ25pdG8taWRwOlVwZGF0ZVVzZXJQb29sQ2xpZW50XCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpEZXNjcmliZVVzZXJQb29sQ2xpZW50XCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpBZG1pbkNyZWF0ZVVzZXJcIixcbiAgICAgICAgICBcImNvZ25pdG8taWRwOkxpc3RVc2Vyc1wiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6VGFnUmVzb3VyY2VcIixcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJsYW1iZGE6QWRkUGVybWlzc2lvblwiLCBcImxhbWJkYTpSZW1vdmVQZXJtaXNzaW9uXCJdLFxuICAgICAgICByZXNvdXJjZXM6IHRyaWdnZXJBcm5zLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBDdXN0b20gZG9tYWluICsgRE5TXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGlmIChjdXN0b21Eb21haW4gJiYgY3VzdG9tRG9tYWluWm9uZSkge1xuICAgICAgaWYgKCF3aWxkY2FyZENlcnRpZmljYXRlQXJuKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIndpbGRjYXJkQ2VydGlmaWNhdGVBcm4gaXMgcmVxdWlyZWQgd2hlbiBjdXN0b21Eb21haW4gaXMgc2V0XCJcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgY2VydGlmaWNhdGUgPSBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKFxuICAgICAgICB0aGlzLFxuICAgICAgICBcIkNlcnRpZmljYXRlXCIsXG4gICAgICAgIHdpbGRjYXJkQ2VydGlmaWNhdGVBcm5cbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IGhvc3RlZFpvbmUgPSByb3V0ZTUzLkhvc3RlZFpvbmUuZnJvbUxvb2t1cCh0aGlzLCBcIkhvc3RlZFpvbmVcIiwge1xuICAgICAgICBkb21haW5OYW1lOiBjdXN0b21Eb21haW5ab25lLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEV4cG9zZSBob3N0ZWQgem9uZSBJRCArIGdyYW50IFJvdXRlNTMgcmVjb3JkLXNldCBtYW5hZ2VtZW50IHNvIHRoZVxuICAgICAgLy8gb3JnIExhbWJkYSBjYW4gd3JpdGUgREtJTSArIHJldHVybi1wYXRoIHJlY29yZHMgd2hlbiBwcm92aXNpb25pbmdcbiAgICAgIC8vIHBlci1hcHAgUG9zdG1hcmsgZG9tYWlucyB2aWEgZW5hYmxlLWF1dGguXG4gICAgICBmbi5hZGRFbnZpcm9ubWVudChcIkhPU1RFRF9aT05FX0lEXCIsIGhvc3RlZFpvbmUuaG9zdGVkWm9uZUlkKTtcbiAgICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgIFwicm91dGU1MzpDaGFuZ2VSZXNvdXJjZVJlY29yZFNldHNcIixcbiAgICAgICAgICAgIFwicm91dGU1MzpMaXN0UmVzb3VyY2VSZWNvcmRTZXRzXCIsXG4gICAgICAgICAgICBcInJvdXRlNTM6R2V0SG9zdGVkWm9uZVwiLFxuICAgICAgICAgIF0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgICBgYXJuOmF3czpyb3V0ZTUzOjo6aG9zdGVkem9uZS8ke2hvc3RlZFpvbmUuaG9zdGVkWm9uZUlkfWAsXG4gICAgICAgICAgXSxcbiAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICAgIC8vIEFQSSBHYXRld2F5IGN1c3RvbSBkb21haW4gZm9yIE1DUCAoZXhhY3QgZG9tYWluKVxuICAgICAgY29uc3QgZG9tYWluTmFtZSA9IG5ldyBhcGlnd3YyLkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgICAgZG9tYWluTmFtZTogY3VzdG9tRG9tYWluLFxuICAgICAgICBjZXJ0aWZpY2F0ZSxcbiAgICAgIH0pO1xuXG4gICAgICBuZXcgYXBpZ3d2Mi5BcGlNYXBwaW5nKHRoaXMsIFwiQXBpTWFwcGluZ1wiLCB7XG4gICAgICAgIGFwaTogaHR0cEFwaSxcbiAgICAgICAgZG9tYWluTmFtZSxcbiAgICAgIH0pO1xuXG4gICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiBjdXN0b21Eb21haW4sXG4gICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKFxuICAgICAgICAgIG5ldyB0YXJnZXRzLkFwaUdhdGV3YXl2MkRvbWFpblByb3BlcnRpZXMoXG4gICAgICAgICAgICBkb21haW5OYW1lLnJlZ2lvbmFsRG9tYWluTmFtZSxcbiAgICAgICAgICAgIGRvbWFpbk5hbWUucmVnaW9uYWxIb3N0ZWRab25lSWRcbiAgICAgICAgICApXG4gICAgICAgICksXG4gICAgICB9KTtcblxuICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgLy8gQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gZm9yIGZyb250ZW5kICgqLntjdXN0b21Eb21haW59KVxuICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgICBpZiAoY29nbml0b1VzZXJQb29sSWQgJiYgY29nbml0b0NsaWVudElkKSB7XG4gICAgICAgIGNvbnN0IGNsb3VkZnJvbnRDZXJ0aWZpY2F0ZSA9IG5ldyBhY20uRG5zVmFsaWRhdGVkQ2VydGlmaWNhdGUoXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICBcIkNsb3VkRnJvbnRDZXJ0aWZpY2F0ZVwiLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGRvbWFpbk5hbWU6IGAqLiR7Y3VzdG9tRG9tYWlufWAsXG4gICAgICAgICAgICBob3N0ZWRab25lLFxuICAgICAgICAgICAgcmVnaW9uOiBcInVzLWVhc3QtMVwiLFxuICAgICAgICAgIH1cbiAgICAgICAgKTtcblxuICAgICAgICAvLyBDbG91ZEZyb250IEZ1bmN0aW9uOiBleHRyYWN0IGFwcCBzdWJkb21haW4g4oaSIHByZXBlbmQgdG8gcGF0aCwgYW5kXG4gICAgICAgIC8vICh3aGVuIHRoZSBvcmcgTGFtYmRhIHJlZ2VuZXJhdGVzIHRoZSBjb2RlKSByb3V0ZSBjdXN0b20gdmFuaXR5XG4gICAgICAgIC8vIGRvbWFpbnMgdmlhIGEgcGVyLWhvc3QgZG9tYWluTWFwIGxvb2t1cC5cbiAgICAgICAgLy9cbiAgICAgICAgLy8gVGhpcyBpbmxpbmUgY29kZSBpcyB0aGUgQk9PVFNUUkFQIHZlcnNpb24gd2l0aCBhbiBlbXB0eSBkb21haW5NYXAuXG4gICAgICAgIC8vIE9uIHRoZSBmaXJzdCBgc2V0LWN1c3RvbS1kb21haW5zYC9gY2hlY2stY3VzdG9tLWRvbWFpbnNgIGN5Y2xlIHRoZVxuICAgICAgICAvLyBvcmcgTGFtYmRhIG92ZXJ3cml0ZXMgdGhpcyBmdW5jdGlvbiB3aXRoIGEgcmVnZW5lcmF0ZWQgdmVyc2lvbiB0aGF0XG4gICAgICAgIC8vIGNvbnRhaW5zIHRoZSBhY3RpdmUgZG9tYWlu4oaSc2NoZW1hIG1hcHBpbmcuIFRoZSBzaGFwZSBtdXN0IG1hdGNoXG4gICAgICAgIC8vIHNyYy9jdXN0b20tZG9tYWluLXRlbXBsYXRlLnRzIGluIHRoZSBoZXJleWEtYXBwcyByZXBvIHNvIHJ1bnRpbWVcbiAgICAgICAgLy8gdXBkYXRlcyBhcmUgZHJvcC1pbiByZXBsYWNlbWVudHMuXG4gICAgICAgIGNvbnN0IGNmRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlN1YmRvbWFpblJld3JpdGVcIiwge1xuICAgICAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21JbmxpbmUoYFxuZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuICB2YXIgcmVxdWVzdCA9IGV2ZW50LnJlcXVlc3Q7XG4gIHZhciBob3N0ID0gcmVxdWVzdC5oZWFkZXJzLmhvc3QudmFsdWU7XG4gIHZhciBjdXN0b21Eb21haW4gPSAke0pTT04uc3RyaW5naWZ5KGN1c3RvbURvbWFpbil9O1xuICB2YXIgZG9tYWluTWFwID0ge307XG4gIGlmIChkb21haW5NYXBbaG9zdF0pIHtcbiAgICByZXF1ZXN0LnVyaSA9ICcvJyArIGRvbWFpbk1hcFtob3N0XSArIHJlcXVlc3QudXJpO1xuICAgIHJldHVybiByZXF1ZXN0O1xuICB9XG4gIGlmIChob3N0ICE9PSBjdXN0b21Eb21haW4gJiYgaG9zdC5lbmRzV2l0aCgnLicgKyBjdXN0b21Eb21haW4pKSB7XG4gICAgdmFyIGFwcE5hbWUgPSBob3N0LnNsaWNlKDAsIC0oY3VzdG9tRG9tYWluLmxlbmd0aCArIDEpKTtcbiAgICByZXF1ZXN0LnVyaSA9ICcvJyArIGFwcE5hbWUgKyByZXF1ZXN0LnVyaTtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cbiAgICAgICAgICBgKSxcbiAgICAgICAgICBmdW5jdGlvbk5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1zdWJkb21haW4tcmV3cml0ZWAsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEFQSSBHYXRld2F5IG9yaWdpblxuICAgICAgICBjb25zdCBhcGlEb21haW5OYW1lID0gY2RrLkZuLnNlbGVjdChcbiAgICAgICAgICAyLFxuICAgICAgICAgIGNkay5Gbi5zcGxpdChcIi9cIiwgaHR0cEFwaS5hcGlFbmRwb2ludClcbiAgICAgICAgKTtcblxuICAgICAgICBjb25zdCBkaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24oXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICBcIkZyb250ZW5kRGlzdHJpYnV0aW9uXCIsXG4gICAgICAgICAge1xuICAgICAgICAgICAgY2VydGlmaWNhdGU6IGNsb3VkZnJvbnRDZXJ0aWZpY2F0ZSxcbiAgICAgICAgICAgIGRvbWFpbk5hbWVzOiBbYCouJHtjdXN0b21Eb21haW59YF0sXG4gICAgICAgICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgICAgICAgb3JpZ2luOiBuZXcgb3JpZ2lucy5IdHRwT3JpZ2luKGFwaURvbWFpbk5hbWUsIHtcbiAgICAgICAgICAgICAgICBwcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5PcmlnaW5Qcm90b2NvbFBvbGljeS5IVFRQU19PTkxZLFxuICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6XG4gICAgICAgICAgICAgICAgY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICAgICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBuZXcgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UG9saWN5KFxuICAgICAgICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgICAgICAgXCJGcm9udGVuZE9yaWdpblBvbGljeVwiLFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgIGNvb2tpZUJlaGF2aW9yOlxuICAgICAgICAgICAgICAgICAgICBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5hbGxvd0xpc3QoXG4gICAgICAgICAgICAgICAgICAgICAgXCJoZXJleWFfaWRfdG9rZW5cIixcbiAgICAgICAgICAgICAgICAgICAgICBcImhlcmV5YV9hZ2VudFwiXG4gICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICBoZWFkZXJCZWhhdmlvcjpcbiAgICAgICAgICAgICAgICAgICAgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0SGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KFxuICAgICAgICAgICAgICAgICAgICAgIFwiQ29udGVudC1UeXBlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgXCJBY2NlcHQtTGFuZ3VhZ2VcIixcbiAgICAgICAgICAgICAgICAgICAgICAvLyBUaGUgc3ViZG9tYWluLXJld3JpdGUgdmlld2VyLXJlcXVlc3QgQ0YgZnVuY3Rpb24gY29waWVzXG4gICAgICAgICAgICAgICAgICAgICAgLy8gdGhlIHZpZXdlciBIb3N0IGludG8geC1mb3J3YXJkZWQtaG9zdCBzbyB0aGUgYXV0aCBMYW1iZGFcbiAgICAgICAgICAgICAgICAgICAgICAvLyBjYW4gc2NvcGUgdGhlIHNlc3Npb24gY29va2llJ3MgRG9tYWluIGF0dHJpYnV0ZSB0byB0aGVcbiAgICAgICAgICAgICAgICAgICAgICAvLyBob3N0IHRoZSB1c2VyIGFjdHVhbGx5IHR5cGVkIChpbmNsdWRpbmcgY3VzdG9tIHZhbml0eVxuICAgICAgICAgICAgICAgICAgICAgIC8vIGRvbWFpbnMpLiBDbG91ZEZyb250IHN0cmlwcyBoZWFkZXJzIGFkZGVkIGJ5IHZpZXdlci1cbiAgICAgICAgICAgICAgICAgICAgICAvLyByZXF1ZXN0IGZ1bmN0aW9ucyBiZWZvcmUgZm9yd2FyZGluZyB0byBvcmlnaW4gdW5sZXNzXG4gICAgICAgICAgICAgICAgICAgICAgLy8gdGhleSdyZSBleHBsaWNpdGx5IHdoaXRlbGlzdGVkIGhlcmUg4oCUIHdpdGhvdXQgdGhpc1xuICAgICAgICAgICAgICAgICAgICAgIC8vIGVudHJ5LCB2YW5pdHktaG9zdCBsb2dpbnMgc2V0IGEgY29va2llIHNjb3BlZCB0byB0aGVcbiAgICAgICAgICAgICAgICAgICAgICAvLyBkZWZhdWx0IGN1c3RvbURvbWFpbiBhbmQgdGhlIGJyb3dzZXIgc2lsZW50bHkgcmVqZWN0c1xuICAgICAgICAgICAgICAgICAgICAgIC8vIGl0IChSRkMgNjI2NSBkb21haW4gbWlzbWF0Y2gpLCBicmVha2luZyBsb2dpbi5cbiAgICAgICAgICAgICAgICAgICAgICBcIngtZm9yd2FyZGVkLWhvc3RcIixcbiAgICAgICAgICAgICAgICAgICAgICAvLyBJbmJvdW5kIHdlYmhvb2sgcHJvdmlkZXJzIGNhcnJ5IGEgc2hhcmVkIHNlY3JldCBpbiBhXG4gICAgICAgICAgICAgICAgICAgICAgLy8gY3VzdG9tIGhlYWRlciB0aGF0IHRoZSBwZXItYXBwIHdlYmhvb2sgaGFuZGxlciB2ZXJpZmllcy5cbiAgICAgICAgICAgICAgICAgICAgICAvLyBDbG91ZEZyb250IHdoaXRlbGlzdHMgaGVhZGVycyBmb3J3YXJkZWQgdG8gb3JpZ2luLCBzb1xuICAgICAgICAgICAgICAgICAgICAgIC8vIHRoZXNlIG11c3QgYmUgbGlzdGVkIG9yIHRoZXkncmUgc3RyaXBwZWQgKGNhdXNpbmcgdGhlXG4gICAgICAgICAgICAgICAgICAgICAgLy8gaGFuZGxlciB0byA0MDEgZXZlcnkgZGVsaXZlcnkpLiBUZWxlZ3JhbSB1c2VzXG4gICAgICAgICAgICAgICAgICAgICAgLy8gWC1UZWxlZ3JhbS1Cb3QtQXBpLVNlY3JldC1Ub2tlbi5cbiAgICAgICAgICAgICAgICAgICAgICBcIlgtVGVsZWdyYW0tQm90LUFwaS1TZWNyZXQtVG9rZW5cIlxuICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjpcbiAgICAgICAgICAgICAgICAgICAgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgZnVuY3Rpb246IGNmRnVuY3Rpb24sXG4gICAgICAgICAgICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25FdmVudFR5cGUuVklFV0VSX1JFUVVFU1QsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIFJvdXRlNTMgd2lsZGNhcmQgLT4gQ2xvdWRGcm9udFxuICAgICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiV2lsZGNhcmRBbGlhc1JlY29yZFwiLCB7XG4gICAgICAgICAgem9uZTogaG9zdGVkWm9uZSxcbiAgICAgICAgICByZWNvcmROYW1lOiBgKi4ke2N1c3RvbURvbWFpbn1gLFxuICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKFxuICAgICAgICAgICAgbmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldChkaXN0cmlidXRpb24pXG4gICAgICAgICAgKSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJGcm9udGVuZERpc3RyaWJ1dGlvbkRvbWFpblwiLCB7XG4gICAgICAgICAgdmFsdWU6IGRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Eb21haW5OYW1lLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgICAvLyBDdXN0b20tZG9tYWluIHN1cHBvcnQgd2lyaW5nXG4gICAgICAgIC8vXG4gICAgICAgIC8vIFRoZSBvcmcgTGFtYmRhIGV4cG9zZXMgTUNQIHRvb2xzIHRoYXQgc3dhcCB0aGUgZGlzdHJpYnV0aW9uJ3NcbiAgICAgICAgLy8gVmlld2VyQ2VydGlmaWNhdGUgaW4tcGxhY2Ugd2hlbiB1c2VycyByZXF1ZXN0IHZhbml0eSBkb21haW5zLiBXZTpcbiAgICAgICAgLy8gICAxLiBTZWVkIGFuIFNTTSBwYXJhbSB3aXRoIHRoZSBib290c3RyYXAgd2lsZGNhcmQgY2VydCBBUk4gb25cbiAgICAgICAgLy8gICAgICBmaXJzdCBkZXBsb3kgKG9uVXBkYXRlIGlzIGEgbm8tb3Ag4oaSIHN1YnNlcXVlbnQgZGVwbG95cyBkb24ndFxuICAgICAgICAvLyAgICAgIG92ZXJ3cml0ZSB0aGUgTGFtYmRhJ3MgbGl2ZSBjZXJ0IEFSTikuXG4gICAgICAgIC8vICAgMi4gR3JhbnQgdGhlIG9yZyBMYW1iZGEgQUNNICh0YWctc2NvcGVkKSArIENsb3VkRnJvbnQgKEFSTi1zY29wZWQpXG4gICAgICAgIC8vICAgICAgKyBTU00gKHBhdGgtc2NvcGVkKSBwZXJtaXNzaW9ucy5cbiAgICAgICAgLy8gICAzLiBQYXNzIGRpc3RyaWJ1dGlvbiArIGZ1bmN0aW9uIGlkZW50aWZpZXJzICsgU1NNIHBhdGggdGhyb3VnaCBlbnYuXG4gICAgICAgIC8vXG4gICAgICAgIC8vIE5PVEUgb24gZHJpZnQ6IGlmIGEgZnV0dXJlIENESyBzdGFjayBjaGFuZ2UgdG91Y2hlcyB0aGUgRGlzdHJpYnV0aW9uXG4gICAgICAgIC8vIG9yIHRoZSBDRiBmdW5jdGlvbiwgQ2xvdWRGb3JtYXRpb24gd2lsbCByZS1zZW5kIENESydzIGlubGluZSBjb25maWdcbiAgICAgICAgLy8gYW5kIG92ZXJ3cml0ZSB0aGUgTGFtYmRhJ3MgbGl2ZSBzdGF0ZS4gUmVtZWRpYXRpb24gaXMgdG8gcmUtcnVuXG4gICAgICAgIC8vIGBjaGVjay1jdXN0b20tZG9tYWluc2AgYWZ0ZXIgdGhlIHN0YWNrIHVwZGF0ZS5cbiAgICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgICAgICBjb25zdCB2aWV3ZXJDZXJ0U3NtUGFyYW1OYW1lID0gYC9oZXJleWEvJHtvcmdhbml6YXRpb25JZH0vdmlld2VyLWNlcnQtYXJuYDtcbiAgICAgICAgY29uc3Qgdmlld2VyQ2VydFNzbVBhcmFtQXJuID0gYGFybjphd3M6c3NtOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpwYXJhbWV0ZXIke3ZpZXdlckNlcnRTc21QYXJhbU5hbWV9YDtcblxuICAgICAgICBjb25zdCBzZWVkVmlld2VyQ2VydEFybiA9IG5ldyBjci5Bd3NDdXN0b21SZXNvdXJjZShcbiAgICAgICAgICB0aGlzLFxuICAgICAgICAgIFwiVmlld2VyQ2VydFNzbVNlZWRcIixcbiAgICAgICAgICB7XG4gICAgICAgICAgICBvbkNyZWF0ZToge1xuICAgICAgICAgICAgICBzZXJ2aWNlOiBcIlNTTVwiLFxuICAgICAgICAgICAgICBhY3Rpb246IFwiUHV0UGFyYW1ldGVyXCIsXG4gICAgICAgICAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgICAgICBOYW1lOiB2aWV3ZXJDZXJ0U3NtUGFyYW1OYW1lLFxuICAgICAgICAgICAgICAgIFZhbHVlOiBjbG91ZGZyb250Q2VydGlmaWNhdGUuY2VydGlmaWNhdGVBcm4sXG4gICAgICAgICAgICAgICAgVHlwZTogXCJTdHJpbmdcIixcbiAgICAgICAgICAgICAgICBPdmVyd3JpdGU6IGZhbHNlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBwaHlzaWNhbFJlc291cmNlSWQ6IGNyLlBoeXNpY2FsUmVzb3VyY2VJZC5vZihcbiAgICAgICAgICAgICAgICBgdmlld2VyLWNlcnQtc2VlZC0ke29yZ2FuaXphdGlvbklkfWBcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgaWdub3JlRXJyb3JDb2Rlc01hdGNoaW5nOiBcIlBhcmFtZXRlckFscmVhZHlFeGlzdHNcIixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBvblVwZGF0ZToge1xuICAgICAgICAgICAgICBzZXJ2aWNlOiBcIlNTTVwiLFxuICAgICAgICAgICAgICBhY3Rpb246IFwiR2V0UGFyYW1ldGVyXCIsXG4gICAgICAgICAgICAgIHBhcmFtZXRlcnM6IHsgTmFtZTogdmlld2VyQ2VydFNzbVBhcmFtTmFtZSB9LFxuICAgICAgICAgICAgICBwaHlzaWNhbFJlc291cmNlSWQ6IGNyLlBoeXNpY2FsUmVzb3VyY2VJZC5vZihcbiAgICAgICAgICAgICAgICBgdmlld2VyLWNlcnQtc2VlZC0ke29yZ2FuaXphdGlvbklkfWBcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgaWdub3JlRXJyb3JDb2Rlc01hdGNoaW5nOiBcIlBhcmFtZXRlck5vdEZvdW5kXCIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgb25EZWxldGU6IHtcbiAgICAgICAgICAgICAgc2VydmljZTogXCJTU01cIixcbiAgICAgICAgICAgICAgYWN0aW9uOiBcIkRlbGV0ZVBhcmFtZXRlclwiLFxuICAgICAgICAgICAgICBwYXJhbWV0ZXJzOiB7IE5hbWU6IHZpZXdlckNlcnRTc21QYXJhbU5hbWUgfSxcbiAgICAgICAgICAgICAgaWdub3JlRXJyb3JDb2Rlc01hdGNoaW5nOiBcIlBhcmFtZXRlck5vdEZvdW5kXCIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgcG9saWN5OiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5mcm9tU3RhdGVtZW50cyhbXG4gICAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgICBcInNzbTpQdXRQYXJhbWV0ZXJcIixcbiAgICAgICAgICAgICAgICAgIFwic3NtOkdldFBhcmFtZXRlclwiLFxuICAgICAgICAgICAgICAgICAgXCJzc206RGVsZXRlUGFyYW1ldGVyXCIsXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICByZXNvdXJjZXM6IFt2aWV3ZXJDZXJ0U3NtUGFyYW1Bcm5dLFxuICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgaW5zdGFsbExhdGVzdEF3c1NkazogZmFsc2UsXG4gICAgICAgICAgfVxuICAgICAgICApO1xuICAgICAgICBzZWVkVmlld2VyQ2VydEFybi5ub2RlLmFkZERlcGVuZGVuY3koY2xvdWRmcm9udENlcnRpZmljYXRlKTtcblxuICAgICAgICAvLyAtLS0gQUNNICh0YWctc2NvcGVkKTogYW55IGNlcnQgdGhlIG9yZyBMYW1iZGEgY3JlYXRlcyBtdXN0IGJlXG4gICAgICAgIC8vICAgICB0YWdnZWQgd2l0aCBpdHMgb3duIG9yZ0lkOyBhbGwgbm9uLWNyZWF0ZSBhY3Rpb25zIGFyZSBnYXRlZCBvblxuICAgICAgICAvLyAgICAgdGhlIHNhbWUgdGFnIG1hdGNoaW5nIG9uIHRoZSByZXNvdXJjZS4gVGhpcyBwcmV2ZW50cyBvcmcgQSBmcm9tXG4gICAgICAgIC8vICAgICB0b3VjaGluZyBvcmcgQidzIGNlcnRzLlxuICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICBcImFjbTpSZXF1ZXN0Q2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgICAgXCJhY206QWRkVGFnc1RvQ2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICAgICAgIFwiYXdzOlJlcXVlc3RUYWcvaGVyZXlhOm9yZ0lkXCI6IG9yZ2FuaXphdGlvbklkLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBcIkZvckFsbFZhbHVlczpTdHJpbmdFcXVhbHNcIjoge1xuICAgICAgICAgICAgICAgIFwiYXdzOlRhZ0tleXNcIjogW1xuICAgICAgICAgICAgICAgICAgXCJoZXJleWE6b3JnSWRcIixcbiAgICAgICAgICAgICAgICAgIFwiaGVyZXlhOnNjaGVtYVwiLFxuICAgICAgICAgICAgICAgICAgXCJoZXJleWE6ZG9tYWluc1wiLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pXG4gICAgICAgICk7XG4gICAgICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgIFwiYWNtOkRlc2NyaWJlQ2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgICAgXCJhY206RGVsZXRlQ2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgICAgXCJhY206TGlzdFRhZ3NGb3JDZXJ0aWZpY2F0ZVwiLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgICAgICBgYXJuOmF3czphY206dXMtZWFzdC0xOiR7dGhpcy5hY2NvdW50fTpjZXJ0aWZpY2F0ZS8qYCxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICAgICAgIFwiYXdzOlJlc291cmNlVGFnL2hlcmV5YTpvcmdJZFwiOiBvcmdhbml6YXRpb25JZCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSlcbiAgICAgICAgKTtcblxuICAgICAgICAvLyAtLS0gQ2xvdWRGcm9udCAoQVJOLXNjb3BlZCk6IHRoZSBvcmcgTGFtYmRhIG1heSBvbmx5IHVwZGF0ZSBJVFNcbiAgICAgICAgLy8gICAgIG93biBkaXN0cmlidXRpb24gYW5kIGZ1bmN0aW9uLlxuICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICBcImNsb3VkZnJvbnQ6R2V0RGlzdHJpYnV0aW9uXCIsXG4gICAgICAgICAgICAgIFwiY2xvdWRmcm9udDpHZXREaXN0cmlidXRpb25Db25maWdcIixcbiAgICAgICAgICAgICAgXCJjbG91ZGZyb250OlVwZGF0ZURpc3RyaWJ1dGlvblwiLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgICAgICBgYXJuOmF3czpjbG91ZGZyb250Ojoke3RoaXMuYWNjb3VudH06ZGlzdHJpYnV0aW9uLyR7ZGlzdHJpYnV0aW9uLmRpc3RyaWJ1dGlvbklkfWAsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH0pXG4gICAgICAgICk7XG4gICAgICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgIFwiY2xvdWRmcm9udDpHZXRGdW5jdGlvblwiLFxuICAgICAgICAgICAgICBcImNsb3VkZnJvbnQ6RGVzY3JpYmVGdW5jdGlvblwiLFxuICAgICAgICAgICAgICBcImNsb3VkZnJvbnQ6VXBkYXRlRnVuY3Rpb25cIixcbiAgICAgICAgICAgICAgXCJjbG91ZGZyb250OlB1Ymxpc2hGdW5jdGlvblwiLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgICAgICBgYXJuOmF3czpjbG91ZGZyb250Ojoke3RoaXMuYWNjb3VudH06ZnVuY3Rpb24vJHtjZkZ1bmN0aW9uLmZ1bmN0aW9uTmFtZX1gLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9KVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIC0tLSBTU00gKHBhdGgtc2NvcGVkKTogd3JpdGUgdGhlIGNlcnQgQVJOIG9uIHN3YXAuXG4gICAgICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICBhY3Rpb25zOiBbXCJzc206R2V0UGFyYW1ldGVyXCIsIFwic3NtOlB1dFBhcmFtZXRlclwiXSxcbiAgICAgICAgICAgIHJlc291cmNlczogW3ZpZXdlckNlcnRTc21QYXJhbUFybl0sXG4gICAgICAgICAgfSlcbiAgICAgICAgKTtcblxuICAgICAgICAvLyAtLS0gRXhwb3NlIElEcyB0byB0aGUgb3JnIExhbWJkYS5cbiAgICAgICAgZm4uYWRkRW52aXJvbm1lbnQoXG4gICAgICAgICAgXCJDTE9VREZST05UX0RJU1RSSUJVVElPTl9JRFwiLFxuICAgICAgICAgIGRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25JZFxuICAgICAgICApO1xuICAgICAgICBmbi5hZGRFbnZpcm9ubWVudChcIkNMT1VERlJPTlRfRlVOQ1RJT05fTkFNRVwiLCBjZkZ1bmN0aW9uLmZ1bmN0aW9uTmFtZSk7XG4gICAgICAgIGZuLmFkZEVudmlyb25tZW50KFxuICAgICAgICAgIFwiQ0xPVURGUk9OVF9ET01BSU5cIixcbiAgICAgICAgICBkaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uRG9tYWluTmFtZVxuICAgICAgICApO1xuICAgICAgICBmbi5hZGRFbnZpcm9ubWVudChcIlZJRVdFUl9DRVJUX1NTTV9QQVJBTVwiLCB2aWV3ZXJDZXJ0U3NtUGFyYW1OYW1lKTtcbiAgICAgICAgZm4ubm9kZS5hZGREZXBlbmRlbmN5KHNlZWRWaWV3ZXJDZXJ0QXJuKTtcbiAgICAgIH1cblxuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJTZXJ2aWNlVXJsXCIsIHtcbiAgICAgICAgdmFsdWU6IGBodHRwczovLyR7Y3VzdG9tRG9tYWlufWAsXG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJTZXJ2aWNlVXJsXCIsIHtcbiAgICAgICAgdmFsdWU6IGh0dHBBcGkuYXBpRW5kcG9pbnQsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gZXh0cmFjdERvbWFpblpvbmUoXG4gIGN1c3RvbURvbWFpbjogc3RyaW5nIHwgdW5kZWZpbmVkXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAoIWN1c3RvbURvbWFpbikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgcGFydHMgPSBjdXN0b21Eb21haW4uc3BsaXQoXCIuXCIpO1xuICBpZiAocGFydHMubGVuZ3RoIDwgMikgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBkb21haW4gbmFtZTogXCIgKyBjdXN0b21Eb21haW4pO1xuICByZXR1cm4gcGFydHMubGVuZ3RoID09PSAyID8gY3VzdG9tRG9tYWluIDogcGFydHMuc2xpY2UoMSkuam9pbihcIi5cIik7XG59XG4iXX0=