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
                            "x-forwarded-host"),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGVyZXlhLWF3cy1tY3AtYXBwLWxhbWJkYS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImhlcmV5YS1hd3MtbWNwLWFwcC1sYW1iZGEtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsc0RBQXdDO0FBQ3hDLDJDQUErQztBQUMvQywrREFBaUQ7QUFDakQsc0VBQXdEO0FBQ3hELHdGQUEwRTtBQUMxRSx3RUFBMEQ7QUFDMUQseURBQTJDO0FBQzNDLGlFQUFtRDtBQUNuRCx5RUFBMkQ7QUFDM0Qsd0VBQTBEO0FBQzFELHNGQUF3RTtBQUN4RSx1RUFBeUQ7QUFDekQsNEVBQThEO0FBQzlELGlFQUFtRDtBQUNuRCxtRUFBcUQ7QUFFckQsMkNBQTZCO0FBRTdCLE1BQWEsMEJBQTJCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDdkQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLG9CQUFvQixHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsc0JBQXNCLENBQUMsQ0FBQztRQUNqRSxJQUFJLENBQUMsb0JBQW9CLEVBQUUsQ0FBQztZQUMxQixNQUFNLElBQUksS0FBSyxDQUFDLHVEQUF1RCxDQUFDLENBQUM7UUFDM0UsQ0FBQztRQUVELE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztRQUNyRCxJQUFJLENBQUMsY0FBYyxFQUFFLENBQUM7WUFDcEIsTUFBTSxJQUFJLEtBQUssQ0FBQyxpREFBaUQsQ0FBQyxDQUFDO1FBQ3JFLENBQUM7UUFFRCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixDQUFDLENBQUM7UUFDckQsSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO1lBQ3BCLE1B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QztnQkFDRixFQUFFLENBQUMsY0FBYyxDQUFDLHVCQUF1QixFQUFFLHNCQUFzQixDQUFDLENBQUM7Z0JBQ25FLEVBQUUsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLGlCQUFpQixDQUFDLENBQUM7WUFDM0MsQ0FBQztZQUVELElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO2dCQUNwQyxLQUFLLEVBQUUsV0FBVyxZQUFZLEVBQUU7YUFDakMsQ0FBQyxDQUFDO1FBQ0wsQ0FBQzthQUFNLENBQUM7WUFDTixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtnQkFDcEMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxXQUFXO2FBQzNCLENBQUMsQ0FBQztRQUNMLENBQUM7SUFDSCxDQUFDO0NBQ0Y7QUEzL0JELGdFQTIvQkM7QUFFRCxTQUFTLGlCQUFpQixDQUN4QixZQUFnQztJQUVoQyxJQUFJLENBQUMsWUFBWTtRQUFFLE9BQU8sU0FBUyxDQUFDO0lBQ3BDLE1BQU0sS0FBSyxHQUFHLFlBQVksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDdEMsSUFBSSxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUM7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHVCQUF1QixHQUFHLFlBQVksQ0FBQyxDQUFDO0lBQzlFLE9BQU8sS0FBSyxDQUFDLE1BQU0sS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDdEUsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tIFwiYXdzLWNkay1saWIvY29yZVwiO1xuaW1wb3J0IHsgU2VjcmV0VmFsdWUgfSBmcm9tIFwiYXdzLWNkay1saWIvY29yZVwiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBpbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBzZWNyZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtc2VjcmV0c21hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgYXV0aG9yaXplcnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnNcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyBjciBmcm9tIFwiYXdzLWNkay1saWIvY3VzdG9tLXJlc291cmNlc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcInBhdGhcIjtcblxuZXhwb3J0IGNsYXNzIEhlcmV5YUF3c01jcEFwcExhbWJkYVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgaGVyZXlhUHJvamVjdFJvb3REaXIgPSBwcm9jZXNzLmVudltcImhlcmV5YVByb2plY3RSb290RGlyXCJdO1xuICAgIGlmICghaGVyZXlhUHJvamVjdFJvb3REaXIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcImhlcmV5YVByb2plY3RSb290RGlyIGVudmlyb25tZW50IHZhcmlhYmxlIGlzIHJlcXVpcmVkXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IG9hdXRoU2VydmVyVXJsID0gcHJvY2Vzcy5lbnZbXCJvYXV0aFNlcnZlclVybFwiXTtcbiAgICBpZiAoIW9hdXRoU2VydmVyVXJsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJvYXV0aFNlcnZlclVybCBlbnZpcm9ubWVudCB2YXJpYWJsZSBpcyByZXF1aXJlZFwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBvcmdhbml6YXRpb25JZCA9IHByb2Nlc3MuZW52W1wib3JnYW5pemF0aW9uSWRcIl07XG4gICAgaWYgKCFvcmdhbml6YXRpb25JZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwib3JnYW5pemF0aW9uSWQgZW52aXJvbm1lbnQgdmFyaWFibGUgaXMgcmVxdWlyZWRcIik7XG4gICAgfVxuXG4gICAgY29uc3QgbWVtb3J5U2l6ZSA9IHByb2Nlc3MuZW52W1wibWVtb3J5U2l6ZVwiXVxuICAgICAgPyBwYXJzZUludChwcm9jZXNzLmVudltcIm1lbW9yeVNpemVcIl0pXG4gICAgICA6IDI1NjtcbiAgICBjb25zdCB0aW1lb3V0ID0gcHJvY2Vzcy5lbnZbXCJ0aW1lb3V0XCJdXG4gICAgICA/IHBhcnNlSW50KHByb2Nlc3MuZW52W1widGltZW91dFwiXSlcbiAgICAgIDogMzA7XG4gICAgY29uc3QgaGFuZGxlck5hbWUgPSBwcm9jZXNzLmVudltcImhhbmRsZXJcIl0gPz8gXCJoYW5kbGVyLmhhbmRsZXJcIjtcbiAgICBjb25zdCBjdXN0b21Eb21haW4gPSBwcm9jZXNzLmVudltcImN1c3RvbURvbWFpblwiXTtcbiAgICBjb25zdCBjdXN0b21Eb21haW5ab25lID1cbiAgICAgIHByb2Nlc3MuZW52W1wiY3VzdG9tRG9tYWluWm9uZVwiXSA/PyBleHRyYWN0RG9tYWluWm9uZShjdXN0b21Eb21haW4pO1xuICAgIGNvbnN0IHdpbGRjYXJkQ2VydGlmaWNhdGVBcm4gPSBwcm9jZXNzLmVudltcIndpbGRjYXJkQ2VydGlmaWNhdGVBcm5cIl07XG5cbiAgICAvLyBQYXJzZSBoZXJleWFQcm9qZWN0RW52XG4gICAgY29uc3QgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0gSlNPTi5wYXJzZShcbiAgICAgIHByb2Nlc3MuZW52W1wiaGVyZXlhUHJvamVjdEVudlwiXSA/PyBcInt9XCJcbiAgICApO1xuXG4gICAgLy8gU2VwYXJhdGUgSUFNIHBvbGljeSBlbnYgdmFyc1xuICAgIGNvbnN0IHBvbGljeUVudiA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIE9iamVjdC5lbnRyaWVzKGVudikuZmlsdGVyKFxuICAgICAgICAoW2tleV0pID0+IGtleS5zdGFydHNXaXRoKFwiSUFNX1BPTElDWV9cIikgfHwga2V5LnN0YXJ0c1dpdGgoXCJpYW1Qb2xpY3lcIilcbiAgICAgIClcbiAgICApO1xuXG4gICAgY29uc3Qgbm9uUG9saWN5RW52ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgT2JqZWN0LmVudHJpZXMoZW52KS5maWx0ZXIoXG4gICAgICAgIChba2V5XSkgPT5cbiAgICAgICAgICAha2V5LnN0YXJ0c1dpdGgoXCJJQU1fUE9MSUNZX1wiKSAmJiAha2V5LnN0YXJ0c1dpdGgoXCJpYW1Qb2xpY3lcIilcbiAgICAgIClcbiAgICApO1xuXG4gICAgLy8gU2VwYXJhdGUgc2VjcmV0IGVudiB2YXJzIChzZWNyZXQ6Ly8gcHJlZml4KVxuICAgIGNvbnN0IHNlY3JldEVudkVudHJpZXMgPSBPYmplY3QuZW50cmllcyhub25Qb2xpY3lFbnYpXG4gICAgICAuZmlsdGVyKChbLCB2YWx1ZV0pID0+ICh2YWx1ZSBhcyBzdHJpbmcpLnN0YXJ0c1dpdGgoXCJzZWNyZXQ6Ly9cIikpXG4gICAgICAubWFwKChba2V5LCB2YWx1ZV0pID0+IHtcbiAgICAgICAgY29uc3QgcGxhaW5WYWx1ZSA9ICh2YWx1ZSBhcyBzdHJpbmcpLnNwbGl0KFwic2VjcmV0Oi8vXCIpWzFdO1xuICAgICAgICBjb25zdCBzZWNyZXROYW1lID0gYC8ke3RoaXMuc3RhY2tOYW1lfS8ke2tleX1gO1xuICAgICAgICBjb25zdCBzZWNyZXQgPSBuZXcgc2VjcmV0cy5TZWNyZXQodGhpcywga2V5LCB7XG4gICAgICAgICAgc2VjcmV0TmFtZSxcbiAgICAgICAgICBzZWNyZXRTdHJpbmdWYWx1ZTogU2VjcmV0VmFsdWUudW5zYWZlUGxhaW5UZXh0KHBsYWluVmFsdWUpLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsga2V5LCBzZWNyZXQsIHNlY3JldE5hbWUgfTtcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgcGxhaW5FbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICBPYmplY3QuZW50cmllcyhub25Qb2xpY3lFbnYpLmZpbHRlcihcbiAgICAgICAgKFssIHZhbHVlXSkgPT4gISh2YWx1ZSBhcyBzdHJpbmcpLnN0YXJ0c1dpdGgoXCJzZWNyZXQ6Ly9cIilcbiAgICAgIClcbiAgICApO1xuXG5cbiAgICAvLyBDb2duaXRvIGNvbmZpZyAoZnJvbSBhd3MvY29nbml0byBwYWNrYWdlIG91dHB1dHMgdmlhIGhlcmV5YVByb2plY3RFbnYpXG4gICAgY29uc3QgY29nbml0b1VzZXJQb29sSWQgPSBwbGFpbkVudltcInVzZXJQb29sSWRcIl0gPz8gbm9uUG9saWN5RW52W1widXNlclBvb2xJZFwiXTtcbiAgICBjb25zdCBjb2duaXRvQ2xpZW50SWQgPSBwbGFpbkVudltcInVzZXJQb29sQ2xpZW50SWRcIl0gPz8gbm9uUG9saWN5RW52W1widXNlclBvb2xDbGllbnRJZFwiXTtcbiAgICBjb25zdCBjb2duaXRvUmVnaW9uID0gcGxhaW5FbnZbXCJhd3NDb2duaXRvUmVnaW9uXCJdID8/IG5vblBvbGljeUVudltcImF3c0NvZ25pdG9SZWdpb25cIl0gPz8gcHJvY2Vzcy5lbnZbXCJDREtfREVGQVVMVF9SRUdJT05cIl0gPz8gXCJ1cy1lYXN0LTFcIjtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gTGFtYmRhIG5hbWluZyBwcmVmaXggZm9yIHBlci1hcHAgTGFtYmRhcyAoZGVyaXZlZCBmcm9tIGN1c3RvbURvbWFpbilcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3Qgb3JnUHJlZml4ID0gY3VzdG9tRG9tYWluXG4gICAgICA/IGN1c3RvbURvbWFpbi5zcGxpdChcIi5cIilbMF1cbiAgICAgIDogdGhpcy5zdGFja05hbWUuc3Vic3RyaW5nKDAsIDIwKTtcbiAgICBjb25zdCBhcHBMYW1iZGFOYW1lUHJlZml4ID0gYCR7b3JnUHJlZml4fS1hcHAtYDtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gTGFtYmRhIDE6IEFwcCBIYW5kbGVyIChPcmcgTGFtYmRhIOKAlCBNQ1Agb25seSlcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgLy8gUGFzcyBkZXBsb3ktdGltZSBjb25maWcgdmFycyB0byB0aGUgaGFuZGxlciAobm90IGluIGhlcmV5YVByb2plY3RFbnYpXG4gICAgaWYgKGN1c3RvbURvbWFpbikge1xuICAgICAgcGxhaW5FbnZbXCJjdXN0b21Eb21haW5cIl0gPSBjdXN0b21Eb21haW47XG4gICAgfVxuXG4gICAgY29uc3QgZm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiSGFuZGxlclwiLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWCxcbiAgICAgIGhhbmRsZXI6IGhhbmRsZXJOYW1lLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihoZXJleWFQcm9qZWN0Um9vdERpciwgXCJkaXN0XCIpKSxcbiAgICAgIG1lbW9yeVNpemUsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyh0aW1lb3V0KSxcbiAgICAgIGVudmlyb25tZW50OiBwbGFpbkVudixcbiAgICB9KTtcblxuICAgIC8vIEF0dGFjaCBzZWNyZXQgcmVmZXJlbmNlcyAoc2VjcmV0IG5hbWUsIG5vdCB2YWx1ZSkgYW5kIGdyYW50IHJlYWQgYWNjZXNzXG4gICAgY29uc3Qgc2VjcmV0S2V5czogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHsga2V5LCBzZWNyZXQsIHNlY3JldE5hbWUgfSBvZiBzZWNyZXRFbnZFbnRyaWVzKSB7XG4gICAgICBmbi5hZGRFbnZpcm9ubWVudChrZXksIHNlY3JldE5hbWUpO1xuICAgICAgc2VjcmV0LmdyYW50UmVhZChmbik7XG4gICAgICBzZWNyZXRLZXlzLnB1c2goa2V5KTtcbiAgICB9XG4gICAgaWYgKHNlY3JldEtleXMubGVuZ3RoID4gMCkge1xuICAgICAgZm4uYWRkRW52aXJvbm1lbnQoXCJTRUNSRVRfS0VZU1wiLCBzZWNyZXRLZXlzLmpvaW4oXCIsXCIpKTtcbiAgICB9XG5cbiAgICAvLyBBdHRhY2ggSUFNIHBvbGljaWVzIGZyb20gZGVwZW5kZW5jeSBwYWNrYWdlc1xuICAgIGZvciAoY29uc3QgWywgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHBvbGljeUVudikpIHtcbiAgICAgIGNvbnN0IHBvbGljeSA9IEpTT04ucGFyc2UodmFsdWUgYXMgc3RyaW5nKTtcbiAgICAgIGZvciAoY29uc3Qgc3RhdGVtZW50IG9mIHBvbGljeS5TdGF0ZW1lbnQpIHtcbiAgICAgICAgZm4uYWRkVG9Sb2xlUG9saWN5KGlhbS5Qb2xpY3lTdGF0ZW1lbnQuZnJvbUpzb24oc3RhdGVtZW50KSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBTaGFyZWQgSUFNIFJvbGUgZm9yIHBlci1hcHAgTGFtYmRhc1xuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBjb25zdCBhcHBMYW1iZGFSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiQXBwTGFtYmRhUm9sZVwiLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImxhbWJkYS5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21NYW5hZ2VkUG9saWN5QXJuKFxuICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgXCJBcHBMYW1iZGFCYXNpY0V4ZWNcIixcbiAgICAgICAgICBcImFybjphd3M6aWFtOjphd3M6cG9saWN5L3NlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGVcIlxuICAgICAgICApLFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vIEFwcGx5IHNhbWUgSUFNIHBvbGljaWVzIGZyb20gZGVwZW5kZW5jeSBwYWNrYWdlcyAoQXVyb3JhLCBTMywgZXRjLilcbiAgICBmb3IgKGNvbnN0IFssIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwb2xpY3lFbnYpKSB7XG4gICAgICBjb25zdCBwb2xpY3kgPSBKU09OLnBhcnNlKHZhbHVlIGFzIHN0cmluZyk7XG4gICAgICBmb3IgKGNvbnN0IHN0YXRlbWVudCBvZiBwb2xpY3kuU3RhdGVtZW50KSB7XG4gICAgICAgIGFwcExhbWJkYVJvbGUuYWRkVG9Qb2xpY3koaWFtLlBvbGljeVN0YXRlbWVudC5mcm9tSnNvbihzdGF0ZW1lbnQpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIExhbWJkYSBMYXllciBmb3IgcGVyLWFwcCBydW50aW1lIHV0aWxpdGllc1xuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBjb25zdCBydW50aW1lTGF5ZXIgPSBuZXcgbGFtYmRhLkxheWVyVmVyc2lvbih0aGlzLCBcIkFwcFJ1bnRpbWVMYXllclwiLCB7XG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoXG4gICAgICAgIHBhdGguam9pbihoZXJleWFQcm9qZWN0Um9vdERpciwgXCJkaXN0XCIsIFwibGF5ZXJcIilcbiAgICAgICksXG4gICAgICBjb21wYXRpYmxlUnVudGltZXM6IFtsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWF0sXG4gICAgICBkZXNjcmlwdGlvbjogXCJIZXJleWEgcnVudGltZSAoZGIsIHN0b3JhZ2UpIGZvciBwZXItYXBwIExhbWJkYXNcIixcbiAgICB9KTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gUGVyLWFwcCBhdXRoOiBzaGFyZWQgbXVsdGktdGVuYW50IENvZ25pdG8gdHJpZ2dlcnMgKyBPVFAgdGFibGUuXG4gICAgLy9cbiAgICAvLyBgZW5hYmxlLWF1dGhgIHByb3Zpc2lvbnMgYSBkZWRpY2F0ZWQgQ29nbml0byB1c2VyIHBvb2wgcGVyIGFwcC4gQWxsXG4gICAgLy8gcG9vbHMgYWNyb3NzIHRoZSBvcmcgYXJlIHdpcmVkIHRvIHRoZSBzYW1lIDQgY2hhbGxlbmdlIHRyaWdnZXIgTGFtYmRhc1xuICAgIC8vIGRlY2xhcmVkIGhlcmUg4oCUIHRoZSB0cmlnZ2VycyBhcmUgcG9vbC1hZ25vc3RpYyAodGhleSByZWFkXG4gICAgLy8gZXZlbnQudXNlclBvb2xJZCBhdCBydW50aW1lKS4gVGhlIE9UUCB0YWJsZSBpcyBrZXllZCBieVxuICAgIC8vIChwb29sX2lkLCBlbWFpbCkgc28gY29uY3VycmVudCBsb2dpbnMgYWNyb3NzIHBvb2xzIGNhbid0IGNvbGxpZGUuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IG90cFRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiQXBwQXV0aE90cFRhYmxlXCIsIHtcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiBcInBvb2xfaWRcIixcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleTogeyBuYW1lOiBcImVtYWlsXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJ0dGxcIixcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICBjb25zdCB0cmlnZ2VyRW52ID0geyBPVFBfVEFCTEVfTkFNRTogb3RwVGFibGUudGFibGVOYW1lIH07XG4gICAgY29uc3QgbWFrZVRyaWdnZXIgPSAoaWQ6IHN0cmluZywgZGlyOiBzdHJpbmcpID0+XG4gICAgICBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIGlkLCB7XG4gICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YLFxuICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KFxuICAgICAgICAgIHBhdGguam9pbihfX2Rpcm5hbWUsIFwiY29nbml0by10cmlnZ2Vyc1wiLCBkaXIpXG4gICAgICAgICksXG4gICAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgICBlbnZpcm9ubWVudDogdHJpZ2dlckVudixcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgcHJlU2lnblVwRm4gPSBtYWtlVHJpZ2dlcihcIlByZVNpZ25VcFRyaWdnZXJcIiwgXCJwcmUtc2lnbi11cFwiKTtcbiAgICBjb25zdCBkZWZpbmVDaGFsbGVuZ2VGbiA9IG1ha2VUcmlnZ2VyKFxuICAgICAgXCJEZWZpbmVBdXRoQ2hhbGxlbmdlVHJpZ2dlclwiLFxuICAgICAgXCJkZWZpbmUtYXV0aC1jaGFsbGVuZ2VcIlxuICAgICk7XG4gICAgY29uc3QgY3JlYXRlQ2hhbGxlbmdlRm4gPSBtYWtlVHJpZ2dlcihcbiAgICAgIFwiQ3JlYXRlQXV0aENoYWxsZW5nZVRyaWdnZXJcIixcbiAgICAgIFwiY3JlYXRlLWF1dGgtY2hhbGxlbmdlXCJcbiAgICApO1xuICAgIGNvbnN0IHZlcmlmeUNoYWxsZW5nZUZuID0gbWFrZVRyaWdnZXIoXG4gICAgICBcIlZlcmlmeUF1dGhDaGFsbGVuZ2VUcmlnZ2VyXCIsXG4gICAgICBcInZlcmlmeS1hdXRoLWNoYWxsZW5nZVwiXG4gICAgKTtcblxuICAgIG90cFRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShjcmVhdGVDaGFsbGVuZ2VGbik7XG4gICAgb3RwVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHZlcmlmeUNoYWxsZW5nZUZuKTtcblxuICAgIC8vIFZlcmlmeSB0cmlnZ2VyIGFsc28gdXBkYXRlcyB0aGUgQ29nbml0byB1c2VyIGF0dHJpYnV0ZSBgZW1haWxfdmVyaWZpZWRgLlxuICAgIC8vIFNjb3BpbmcgdG8gcmVzb3VyY2U9XCIqXCIgYmVjYXVzZSBwZXItYXBwIHBvb2xzIGFyZSBjcmVhdGVkIGF0IHJ1bnRpbWUgYnlcbiAgICAvLyB0aGUgb3JnIExhbWJkYSDigJQgd2UgY2FuJ3QgcGluIGEgc2luZ2xlIEFSTiBhdCBzdGFjayBkZXBsb3kgdGltZS5cbiAgICB2ZXJpZnlDaGFsbGVuZ2VGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcImNvZ25pdG8taWRwOkFkbWluVXBkYXRlVXNlckF0dHJpYnV0ZXNcIl0sXG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIGNvbnN0IHRyaWdnZXJBcm5zID0gW1xuICAgICAgcHJlU2lnblVwRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBkZWZpbmVDaGFsbGVuZ2VGbi5mdW5jdGlvbkFybixcbiAgICAgIGNyZWF0ZUNoYWxsZW5nZUZuLmZ1bmN0aW9uQXJuLFxuICAgICAgdmVyaWZ5Q2hhbGxlbmdlRm4uZnVuY3Rpb25Bcm4sXG4gICAgXTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gTUNQIE9BdXRoIEF1dGhvcml6ZXIgTGFtYmRhXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IGF1dGhvcml6ZXJGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJBdXRob3JpemVySGFuZGxlclwiLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWCxcbiAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsIFwiYXV0aG9yaXplclwiKSksXG4gICAgICBtZW1vcnlTaXplOiAxMjgsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBPQVVUSF9TRVJWRVJfVVJMOiBvYXV0aFNlcnZlclVybCxcbiAgICAgICAgQk9VTkRfT1JHX0lEOiBvcmdhbml6YXRpb25JZCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBodHRwQXV0aG9yaXplciA9IG5ldyBhdXRob3JpemVycy5IdHRwTGFtYmRhQXV0aG9yaXplcihcbiAgICAgIFwiSGVyZXlhQXV0aG9yaXplclwiLFxuICAgICAgYXV0aG9yaXplckZuLFxuICAgICAge1xuICAgICAgICByZXNwb25zZVR5cGVzOiBbYXV0aG9yaXplcnMuSHR0cExhbWJkYVJlc3BvbnNlVHlwZS5TSU1QTEVdLFxuICAgICAgICByZXN1bHRzQ2FjaGVUdGw6IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgfVxuICAgICk7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIEhUVFAgQVBJXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IGh0dHBBcGkgPSBuZXcgYXBpZ3d2Mi5IdHRwQXBpKHRoaXMsIFwiSHR0cEFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiB0aGlzLnN0YWNrTmFtZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGxhbWJkYUludGVncmF0aW9uID0gbmV3IGludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICBcIkxhbWJkYUludGVncmF0aW9uXCIsXG4gICAgICBmblxuICAgICk7XG5cbiAgICAvLyBDb21wdXRlIHNlcnZpY2UgVVJMIGZvciBQUk0gKGN1c3RvbSBkb21haW4gb3IgQVBJIGVuZHBvaW50KVxuICAgIGNvbnN0IHNlcnZpY2VVcmwgPSBjdXN0b21Eb21haW5cbiAgICAgID8gYGh0dHBzOi8vJHtjdXN0b21Eb21haW59YFxuICAgICAgOiBodHRwQXBpLmFwaUVuZHBvaW50O1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBQcm90ZWN0ZWQgUmVzb3VyY2UgTWV0YWRhdGEgKFJGQyA5NzI4KVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBjb25zdCBwcm1MYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiUHJtSGFuZGxlclwiLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWCxcbiAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUlubGluZShgXG4gICAgICAgIGV4cG9ydHMuaGFuZGxlciA9IGFzeW5jICgpID0+ICh7XG4gICAgICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgICAgICAgXCJDYWNoZS1Db250cm9sXCI6IFwicHVibGljLCBtYXgtYWdlPTM2MDBcIixcbiAgICAgICAgICAgIFwiQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IFwiKlwiLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgcmVzb3VyY2U6IHByb2Nlc3MuZW52LlNFUlZJQ0VfVVJMICsgXCIvbWNwXCIsXG4gICAgICAgICAgICBhdXRob3JpemF0aW9uX3NlcnZlcnM6IFtwcm9jZXNzLmVudi5PQVVUSF9TRVJWRVJfVVJMICsgXCIvb2F1dGgvXCIgKyBwcm9jZXNzLmVudi5PUkdBTklaQVRJT05fSURdLFxuICAgICAgICAgICAgYmVhcmVyX21ldGhvZHNfc3VwcG9ydGVkOiBbXCJoZWFkZXJcIl0sXG4gICAgICAgICAgICBzY29wZXNfc3VwcG9ydGVkOiBbXCJtY3A6YWNjZXNzXCJdLFxuICAgICAgICAgIH0pLFxuICAgICAgICB9KTtcbiAgICAgIGApLFxuICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBTRVJWSUNFX1VSTDogc2VydmljZVVybCxcbiAgICAgICAgT0FVVEhfU0VSVkVSX1VSTDogb2F1dGhTZXJ2ZXJVcmwsXG4gICAgICAgIE9SR0FOSVpBVElPTl9JRDogb3JnYW5pemF0aW9uSWQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgaHR0cEFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogXCIvLndlbGwta25vd24vb2F1dGgtcHJvdGVjdGVkLXJlc291cmNlXCIsXG4gICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogbmV3IGludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIFwiUHJtSW50ZWdyYXRpb25cIixcbiAgICAgICAgcHJtTGFtYmRhXG4gICAgICApLFxuICAgIH0pO1xuXG4gICAgLy8gTUNQIHJvdXRlIChleGlzdGluZylcbiAgICBodHRwQXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiBcIi9tY3BcIixcbiAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogbGFtYmRhSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiBodHRwQXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIEFsbG93IEFQSSBHYXRld2F5IHRvIGludm9rZSB0aGUgb3JnIExhbWJkYSBvbiBBTlkgcm91dGUgb2YgdGhpcyBBUEkuXG4gICAgLy8gSHR0cExhbWJkYUludGVncmF0aW9uIG9ubHkgZ3JhbnRzIGEgcm91dGUtc3BlY2lmaWMgcGVybWlzc2lvbiBmb3IgL21jcCxcbiAgICAvLyBidXQgdGhlIG9yZyBMYW1iZGEgY3JlYXRlcyBhZGRpdGlvbmFsIHJvdXRlcyBhdCBydW50aW1lIHRoYXQgdGFyZ2V0XG4gICAgLy8gaXRzZWxmIChlLmcuIHBlci1hcHAgVGVsZWdyYW0gd2ViaG9va3MgYXQgL3tzY2hlbWF9L3RlbGVncmFtL3twcm94eSt9KS5cbiAgICAvLyBXaXRob3V0IGFuIGFwaS1zY29wZWQgcGVybWlzc2lvbiB0aG9zZSByb3V0ZXMgcmV0dXJuIDUwMCAoQVBJIEdhdGV3YXlcbiAgICAvLyBjYW5ub3QgaW52b2tlIHRoZSBMYW1iZGEpLCBhbmQgdGhlIG9yZyBMYW1iZGEgY2Fubm90IHNlbGYtZ3JhbnRcbiAgICAvLyAoaXRzIGxhbWJkYTpBZGRQZXJtaXNzaW9uIElBTSBpcyBzY29wZWQgdG8gcGVyLWFwcCBmdW5jdGlvbiBuYW1lcyBvbmx5KS5cbiAgICBmbi5hZGRQZXJtaXNzaW9uKFwiSHR0cEFwaUludm9rZUFsbFwiLCB7XG4gICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImFwaWdhdGV3YXkuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgIHNvdXJjZUFybjogYGFybjphd3M6ZXhlY3V0ZS1hcGk6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OiR7aHR0cEFwaS5hcGlJZH0vKi8qYCxcbiAgICB9KTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gRnJvbnRlbmQgQXV0aG9yaXplciArIEF1dGggTGFtYmRhIChmb3IgcGVyLWFwcCBMYW1iZGFzKVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAvLyBUaGVzZSBhcmUgY3JlYXRlZCBhdCBDREsgdGltZS4gVGhlaXIgSURzIGFyZSBwYXNzZWQgdG8gdGhlIG9yZyBMYW1iZGFcbiAgICAvLyBzbyBpdCBjYW4gY3JlYXRlIHBlci1hcHAgQVBJIEdhdGV3YXkgcm91dGVzIGR5bmFtaWNhbGx5LlxuXG4gICAgbGV0IGZyb250ZW5kQXV0aG9yaXplcklkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGF1dGhJbnRlZ3JhdGlvbklkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cbiAgICBpZiAoY29nbml0b1VzZXJQb29sSWQgJiYgY29nbml0b0NsaWVudElkKSB7XG4gICAgICAvLyBGcm9udGVuZCBBdXRob3JpemVyIExhbWJkYSAobXVsdGktdGVuYW50OiBwZXItYXBwIHBvb2wgbG9va3VwIHZpYSBEQixcbiAgICAgIC8vIHdpdGggc2hhcmVkLXBvb2wgZmFsbGJhY2sgZm9yIFBoYXNlLUEgbWlncmF0aW9uKS5cbiAgICAgIGNvbnN0IGZyb250ZW5kQXV0aG9yaXplckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbihcbiAgICAgICAgdGhpcyxcbiAgICAgICAgXCJGcm9udGVuZEF1dGhvcml6ZXJIYW5kbGVyXCIsXG4gICAgICAgIHtcbiAgICAgICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWCxcbiAgICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoXG4gICAgICAgICAgICBwYXRoLmpvaW4oX19kaXJuYW1lLCBcImZyb250ZW5kLWF1dGhvcml6ZXJcIilcbiAgICAgICAgICApLFxuICAgICAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICAgIENPR05JVE9fVVNFUl9QT09MX0lEOiBjb2duaXRvVXNlclBvb2xJZCxcbiAgICAgICAgICAgIENPR05JVE9fUkVHSU9OOiBjb2duaXRvUmVnaW9uLFxuICAgICAgICAgICAgY2x1c3RlckFybjogcGxhaW5FbnZbXCJjbHVzdGVyQXJuXCJdID8/IFwiXCIsXG4gICAgICAgICAgICBzZWNyZXRBcm46IHBsYWluRW52W1wic2VjcmV0QXJuXCJdID8/IFwiXCIsXG4gICAgICAgICAgICBkYXRhYmFzZU5hbWU6IHBsYWluRW52W1wiZGF0YWJhc2VOYW1lXCJdID8/IFwiXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgfVxuICAgICAgKTtcblxuICAgICAgLy8gQXBwbHkgQXVyb3JhIERhdGEgQVBJIHBvbGljaWVzIGZyb20gZGVwIHBhY2thZ2VzIHNvIHRoZSBhdXRob3JpemVyIGNhblxuICAgICAgLy8gU0VMRUNUIGZyb20gcHVibGljLl9hcHBfYXV0aC5cbiAgICAgIGZvciAoY29uc3QgWywgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHBvbGljeUVudikpIHtcbiAgICAgICAgY29uc3QgcG9saWN5ID0gSlNPTi5wYXJzZSh2YWx1ZSBhcyBzdHJpbmcpO1xuICAgICAgICBmb3IgKGNvbnN0IHN0YXRlbWVudCBvZiBwb2xpY3kuU3RhdGVtZW50KSB7XG4gICAgICAgICAgZnJvbnRlbmRBdXRob3JpemVyRm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgICAgICAgaWFtLlBvbGljeVN0YXRlbWVudC5mcm9tSnNvbihzdGF0ZW1lbnQpXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBHcmFudCBBUEkgR2F0ZXdheSBwZXJtaXNzaW9uIHRvIGludm9rZSB0aGUgZnJvbnRlbmQgYXV0aG9yaXplclxuICAgICAgZnJvbnRlbmRBdXRob3JpemVyRm4uYWRkUGVybWlzc2lvbihcIkFwaUd3QXV0aG9yaXplckludm9rZVwiLCB7XG4gICAgICAgIHByaW5jaXBhbDogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiYXBpZ2F0ZXdheS5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgICBzb3VyY2VBcm46IGBhcm46YXdzOmV4ZWN1dGUtYXBpOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fToke2h0dHBBcGkuYXBpSWR9LypgLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEZyb250ZW5kIEF1dGhvcml6ZXIgYXMgTDEgY29uc3RydWN0ICh0byBnZXQgYXV0aG9yaXplciBJRClcbiAgICAgIGNvbnN0IGZyb250ZW5kQXV0aG9yaXplckNmbiA9IG5ldyBhcGlnd3YyLkNmbkF1dGhvcml6ZXIoXG4gICAgICAgIHRoaXMsXG4gICAgICAgIFwiRnJvbnRlbmRBdXRob3JpemVyQ2ZuXCIsXG4gICAgICAgIHtcbiAgICAgICAgICBhcGlJZDogaHR0cEFwaS5hcGlJZCxcbiAgICAgICAgICBhdXRob3JpemVyVHlwZTogXCJSRVFVRVNUXCIsXG4gICAgICAgICAgYXV0aG9yaXplclVyaTogYGFybjphd3M6YXBpZ2F0ZXdheToke3RoaXMucmVnaW9ufTpsYW1iZGE6cGF0aC8yMDE1LTAzLTMxL2Z1bmN0aW9ucy8ke2Zyb250ZW5kQXV0aG9yaXplckZuLmZ1bmN0aW9uQXJufS9pbnZvY2F0aW9uc2AsXG4gICAgICAgICAgYXV0aG9yaXplclBheWxvYWRGb3JtYXRWZXJzaW9uOiBcIjIuMFwiLFxuICAgICAgICAgIGVuYWJsZVNpbXBsZVJlc3BvbnNlczogdHJ1ZSxcbiAgICAgICAgICBhdXRob3JpemVyUmVzdWx0VHRsSW5TZWNvbmRzOiAwLFxuICAgICAgICAgIGlkZW50aXR5U291cmNlOiBbXSBhcyBzdHJpbmdbXSwgLy8gZW1wdHkgPSBhbHdheXMgaW52b2tlIChzdXBwb3J0cyBwdWJsaWMgZW5kcG9pbnRzKVxuICAgICAgICAgIG5hbWU6IFwiRnJvbnRlbmRBdXRob3JpemVyVjJcIixcbiAgICAgICAgfVxuICAgICAgKTtcbiAgICAgIGZyb250ZW5kQXV0aG9yaXplcklkID0gZnJvbnRlbmRBdXRob3JpemVyQ2ZuLnJlZjtcblxuICAgICAgLy8gQXV0aCBMYW1iZGEgKGxvZ2luL09UUC92ZXJpZnkvbG9nb3V0KS4gTXVsdGktdGVuYW50OiBleHRyYWN0cyBhcHAgZnJvbVxuICAgICAgLy8gcGF0aCwgbG9va3MgdXAgcGVyLWFwcCBwb29sIGNsaWVudCArIFBvc3RtYXJrIHRva2VuLCBmYWxscyBiYWNrIHRvIHRoZVxuICAgICAgLy8gc2hhcmVkIG9yZyBwb29sIGZvciB1bm1pZ3JhdGVkIGFwcHMuXG4gICAgICBjb25zdCBhdXRoTGFtYmRhRW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgICBDT0dOSVRPX1VTRVJfUE9PTF9JRDogY29nbml0b1VzZXJQb29sSWQsXG4gICAgICAgIENPR05JVE9fQ0xJRU5UX0lEOiBjb2duaXRvQ2xpZW50SWQsXG4gICAgICAgIENPR05JVE9fUkVHSU9OOiBjb2duaXRvUmVnaW9uLFxuICAgICAgICBDVVNUT01fRE9NQUlOOiBjdXN0b21Eb21haW4gPz8gXCJcIixcbiAgICAgICAgQlVDS0VUX05BTUU6IHBsYWluRW52W1wiYnVja2V0TmFtZVwiXSA/PyBcIlwiLFxuICAgICAgICBTM19QUkVGSVg6IHBsYWluRW52W1wiczNQcmVmaXhcIl0gPz8gXCJcIixcbiAgICAgICAgT1JHQU5JWkFUSU9OX0lEOiBvcmdhbml6YXRpb25JZCxcbiAgICAgICAgY2x1c3RlckFybjogcGxhaW5FbnZbXCJjbHVzdGVyQXJuXCJdID8/IFwiXCIsXG4gICAgICAgIHNlY3JldEFybjogcGxhaW5FbnZbXCJzZWNyZXRBcm5cIl0gPz8gXCJcIixcbiAgICAgICAgZGF0YWJhc2VOYW1lOiBwbGFpbkVudltcImRhdGFiYXNlTmFtZVwiXSA/PyBcIlwiLFxuICAgICAgfTtcblxuICAgICAgY29uc3QgYXV0aExhbWJkYUZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIkF1dGhMYW1iZGFIYW5kbGVyXCIsIHtcbiAgICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgXCJhdXRoLWxhbWJkYVwiKSksXG4gICAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTUpLFxuICAgICAgICBlbnZpcm9ubWVudDogYXV0aExhbWJkYUVudixcbiAgICAgIH0pO1xuXG4gICAgICAvLyBHcmFudCBBdXRoIExhbWJkYSBhY2Nlc3MgdG8gc2VjcmV0c1xuICAgICAgY29uc3QgYXV0aFNlY3JldEtleXM6IHN0cmluZ1tdID0gW107XG4gICAgICBmb3IgKGNvbnN0IHsga2V5LCBzZWNyZXQsIHNlY3JldE5hbWUgfSBvZiBzZWNyZXRFbnZFbnRyaWVzKSB7XG4gICAgICAgIGF1dGhMYW1iZGFGbi5hZGRFbnZpcm9ubWVudChrZXksIHNlY3JldE5hbWUpO1xuICAgICAgICBzZWNyZXQuZ3JhbnRSZWFkKGF1dGhMYW1iZGFGbik7XG4gICAgICAgIGF1dGhTZWNyZXRLZXlzLnB1c2goa2V5KTtcbiAgICAgIH1cbiAgICAgIGlmIChhdXRoU2VjcmV0S2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGF1dGhMYW1iZGFGbi5hZGRFbnZpcm9ubWVudChcIlNFQ1JFVF9LRVlTXCIsIGF1dGhTZWNyZXRLZXlzLmpvaW4oXCIsXCIpKTtcbiAgICAgIH1cblxuICAgICAgLy8gR3JhbnQgQXV0aCBMYW1iZGEgQ29nbml0byBwZXJtaXNzaW9ucyArIERhdGEgQVBJICh0byByZWFkIF9hcHBfYXV0aCkuXG4gICAgICBmb3IgKGNvbnN0IFssIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwb2xpY3lFbnYpKSB7XG4gICAgICAgIGNvbnN0IHBvbGljeSA9IEpTT04ucGFyc2UodmFsdWUgYXMgc3RyaW5nKTtcbiAgICAgICAgZm9yIChjb25zdCBzdGF0ZW1lbnQgb2YgcG9saWN5LlN0YXRlbWVudCkge1xuICAgICAgICAgIGF1dGhMYW1iZGFGbi5hZGRUb1JvbGVQb2xpY3koaWFtLlBvbGljeVN0YXRlbWVudC5mcm9tSnNvbihzdGF0ZW1lbnQpKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBSZWFkIHBlci1hcHAgUG9zdG1hcmsgc2VydmVyIHRva2VuIGZyb20gU1NNIFNlY3VyZVN0cmluZy5cbiAgICAgIGNvbnN0IGFwcEF1dGhTc21Bcm4gPSBgYXJuOmF3czpzc206JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnBhcmFtZXRlci9oZXJleWEvJHtvcmdhbml6YXRpb25JZH0vYXBwcy8qYDtcbiAgICAgIGF1dGhMYW1iZGFGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBhY3Rpb25zOiBbXCJzc206R2V0UGFyYW1ldGVyXCJdLFxuICAgICAgICAgIHJlc291cmNlczogW2FwcEF1dGhTc21Bcm5dLFxuICAgICAgICB9KVxuICAgICAgKTtcbiAgICAgIGF1dGhMYW1iZGFGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBhY3Rpb25zOiBbXCJrbXM6RGVjcnlwdFwiXSxcbiAgICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgICAgY29uZGl0aW9uczoge1xuICAgICAgICAgICAgU3RyaW5nRXF1YWxzOiB7XG4gICAgICAgICAgICAgIFwia21zOlZpYVNlcnZpY2VcIjogYHNzbS4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tYCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICAgIC8vIEFsbG93IEluaXRpYXRlQXV0aCAvIFJlc3BvbmRUb0F1dGhDaGFsbGVuZ2UgYWdhaW5zdCBhbnkgcGVyLWFwcCBwb29sXG4gICAgICAvLyBpbiB0aGlzIGFjY291bnQgKHBvb2wgQVJOcyBhcmUgY3JlYXRlZCBhdCBydW50aW1lIGJ5IGVuYWJsZS1hdXRoKS5cbiAgICAgIGF1dGhMYW1iZGFGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICBcImNvZ25pdG8taWRwOkluaXRpYXRlQXV0aFwiLFxuICAgICAgICAgICAgXCJjb2duaXRvLWlkcDpSZXNwb25kVG9BdXRoQ2hhbGxlbmdlXCIsXG4gICAgICAgICAgXSxcbiAgICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgICAvLyBHcmFudCBBUEkgR2F0ZXdheSBwZXJtaXNzaW9uIHRvIGludm9rZSBhdXRoIExhbWJkYVxuICAgICAgYXV0aExhbWJkYUZuLmFkZFBlcm1pc3Npb24oXCJBcGlHd0ludm9rZVwiLCB7XG4gICAgICAgIHByaW5jaXBhbDogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiYXBpZ2F0ZXdheS5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgICBzb3VyY2VBcm46IGBhcm46YXdzOmV4ZWN1dGUtYXBpOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fToke2h0dHBBcGkuYXBpSWR9LyovKmAsXG4gICAgICB9KTtcblxuICAgICAgLy8gQXV0aCBMYW1iZGEgaW50ZWdyYXRpb24gYXMgTDEgY29uc3RydWN0ICh0byBnZXQgaW50ZWdyYXRpb24gSUQpXG4gICAgICBjb25zdCBhdXRoSW50ZWdyYXRpb25DZm4gPSBuZXcgYXBpZ3d2Mi5DZm5JbnRlZ3JhdGlvbihcbiAgICAgICAgdGhpcyxcbiAgICAgICAgXCJBdXRoSW50ZWdyYXRpb25DZm5cIixcbiAgICAgICAge1xuICAgICAgICAgIGFwaUlkOiBodHRwQXBpLmFwaUlkLFxuICAgICAgICAgIGludGVncmF0aW9uVHlwZTogXCJBV1NfUFJPWFlcIixcbiAgICAgICAgICBpbnRlZ3JhdGlvblVyaTogYXV0aExhbWJkYUZuLmZ1bmN0aW9uQXJuLFxuICAgICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBcIjIuMFwiLFxuICAgICAgICB9XG4gICAgICApO1xuICAgICAgYXV0aEludGVncmF0aW9uSWQgPSBhdXRoSW50ZWdyYXRpb25DZm4ucmVmO1xuICAgIH1cblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gT3JnIExhbWJkYTogcGVyLWFwcCBMYW1iZGEgbWFuYWdlbWVudCBwZXJtaXNzaW9uc1xuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBjb25zdCBhcHBMYW1iZGFBcm5QYXR0ZXJuID0gYGFybjphd3M6bGFtYmRhOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpmdW5jdGlvbjoke2FwcExhbWJkYU5hbWVQcmVmaXh9KmA7XG5cbiAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcImxhbWJkYTpDcmVhdGVGdW5jdGlvblwiLFxuICAgICAgICAgIFwibGFtYmRhOlVwZGF0ZUZ1bmN0aW9uQ29kZVwiLFxuICAgICAgICAgIFwibGFtYmRhOlVwZGF0ZUZ1bmN0aW9uQ29uZmlndXJhdGlvblwiLFxuICAgICAgICAgIFwibGFtYmRhOkdldEZ1bmN0aW9uXCIsXG4gICAgICAgICAgXCJsYW1iZGE6RGVsZXRlRnVuY3Rpb25cIixcbiAgICAgICAgICBcImxhbWJkYTpBZGRQZXJtaXNzaW9uXCIsXG4gICAgICAgICAgXCJsYW1iZGE6UmVtb3ZlUGVybWlzc2lvblwiLFxuICAgICAgICAgIFwibGFtYmRhOkludm9rZUZ1bmN0aW9uXCIsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW2FwcExhbWJkYUFyblBhdHRlcm5dLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gTGFtYmRhIGxheWVyIGFjY2VzcyAobmVlZGVkIHdoZW4gY3JlYXRpbmcgcGVyLWFwcCBMYW1iZGFzIHdpdGggbGF5ZXJzKVxuICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wibGFtYmRhOkdldExheWVyVmVyc2lvblwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbcnVudGltZUxheWVyLmxheWVyVmVyc2lvbkFybl0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyBBUEkgR2F0ZXdheSByb3V0ZSBtYW5hZ2VtZW50XG4gICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgXCJhcGlnYXRld2F5OlBPU1RcIixcbiAgICAgICAgICBcImFwaWdhdGV3YXk6REVMRVRFXCIsXG4gICAgICAgICAgXCJhcGlnYXRld2F5OkdFVFwiLFxuICAgICAgICAgIFwiYXBpZ2F0ZXdheTpQQVRDSFwiLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICBgYXJuOmF3czphcGlnYXRld2F5OiR7dGhpcy5yZWdpb259OjovYXBpcy8ke2h0dHBBcGkuYXBpSWR9LypgLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gUGFzcyBzaGFyZWQgcm9sZSB0byBwZXItYXBwIExhbWJkYXNcbiAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcImlhbTpQYXNzUm9sZVwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYXBwTGFtYmRhUm9sZS5yb2xlQXJuXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gU1NNIFNlY3VyZVN0cmluZyBmb3IgcGVyLWFwcCBhZ2VudC1zZXNzaW9uIHNpZ25pbmcgc2VjcmV0cy5cbiAgICAvLyBQcmVmaXgtYm91bmQgdG8gL2hlcmV5YS97b3JnYW5pemF0aW9uSWR9L2FwcHMvKiBzbyB0aGUgb3JnIExhbWJkYSBhbmRcbiAgICAvLyBwZXItYXBwIExhbWJkYXMgY2FuIG9ubHkgdG91Y2ggdGhlaXIgb3duIG9yZydzIHNlY3JldHMuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IGFnZW50U2VjcmV0U3NtQXJuID0gYGFybjphd3M6c3NtOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpwYXJhbWV0ZXIvaGVyZXlhLyR7b3JnYW5pemF0aW9uSWR9L2FwcHMvKmA7XG5cbiAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcInNzbTpHZXRQYXJhbWV0ZXJcIixcbiAgICAgICAgICBcInNzbTpHZXRQYXJhbWV0ZXJzXCIsXG4gICAgICAgICAgXCJzc206UHV0UGFyYW1ldGVyXCIsXG4gICAgICAgICAgXCJzc206RGVsZXRlUGFyYW1ldGVyXCIsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW2FnZW50U2VjcmV0U3NtQXJuXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIGFwcExhbWJkYVJvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcInNzbTpHZXRQYXJhbWV0ZXJcIl0sXG4gICAgICAgIHJlc291cmNlczogW2FnZW50U2VjcmV0U3NtQXJuXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIEtNUyBkZWNyeXB0IGZvciB0aGUgQVdTLW1hbmFnZWQgU1NNIGtleSAoU2VjdXJlU3RyaW5nKS5cbiAgICAvLyBTY29wZWQgdmlhIFZpYVNlcnZpY2UgY29uZGl0aW9uIHNvIGl0IG9ubHkgd29ya3MgdGhyb3VnaCBTU00uXG4gICAgY29uc3Qgc3NtS21zRGVjcnlwdCA9IG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFtcImttczpEZWNyeXB0XCJdLFxuICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgY29uZGl0aW9uczoge1xuICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICBcImttczpWaWFTZXJ2aWNlXCI6IGBzc20uJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbWAsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGZuLmFkZFRvUm9sZVBvbGljeShzc21LbXNEZWNyeXB0KTtcbiAgICBhcHBMYW1iZGFSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJrbXM6RGVjcnlwdFwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgICAgU3RyaW5nRXF1YWxzOiB7XG4gICAgICAgICAgICBcImttczpWaWFTZXJ2aWNlXCI6IGBzc20uJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbWAsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIFBlci1hcHAgTGFtYmRhcyBtYXkgb3B0IGluIHRvIHJlZ2lzdGVyaW5nIHVzZXJzIHNlcnZlci1zaWRlIHZpYSB0aGVcbiAgICAvLyBoZXJleWEgcnVudGltZSdzIHVzZXJzLmFkZFVzZXIgaGVscGVyLiBTaW5jZSBwZXItYXBwIENvZ25pdG8gcG9vbHMgYXJlXG4gICAgLy8gbG9ja2VkIHRvIEFsbG93QWRtaW5DcmVhdGVVc2VyT25seT10cnVlLCB0aGUgaGVscGVyIGNhbGxzXG4gICAgLy8gQWRtaW5DcmVhdGVVc2VyLiBTY29wZSBieSB0aGUgSGVyZXlhT3JnIHRhZyBvbiB0aGUgcG9vbCBzbyBvbmUgb3JnJ3NcbiAgICAvLyBwZXItYXBwIExhbWJkYXMgY2Fubm90IGNyZWF0ZSB1c2VycyBpbiBhbm90aGVyIG9yZydzIHBvb2xzLlxuICAgIGFwcExhbWJkYVJvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcImNvZ25pdG8taWRwOkFkbWluQ3JlYXRlVXNlclwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgICAgU3RyaW5nRXF1YWxzOiB7XG4gICAgICAgICAgICBcImF3czpSZXNvdXJjZVRhZy9IZXJleWFPcmdcIjogb3JnYW5pemF0aW9uSWQsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gT3JnIExhbWJkYTogZW52aXJvbm1lbnQgdmFyaWFibGVzIGZvciBwZXItYXBwIExhbWJkYSBtYW5hZ2VtZW50XG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGZuLmFkZEVudmlyb25tZW50KFwiQVBQX0xBTUJEQV9ST0xFX0FSTlwiLCBhcHBMYW1iZGFSb2xlLnJvbGVBcm4pO1xuICAgIGZuLmFkZEVudmlyb25tZW50KFwiQVBQX0xBTUJEQV9OQU1FX1BSRUZJWFwiLCBhcHBMYW1iZGFOYW1lUHJlZml4KTtcbiAgICBmbi5hZGRFbnZpcm9ubWVudChcIkFQUF9MQU1CREFfTEFZRVJfQVJOXCIsIHJ1bnRpbWVMYXllci5sYXllclZlcnNpb25Bcm4pO1xuICAgIGZuLmFkZEVudmlyb25tZW50KFwiSFRUUF9BUElfSURcIiwgaHR0cEFwaS5hcGlJZCk7XG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJBV1NfQUNDT1VOVF9JRFwiLCB0aGlzLmFjY291bnQpO1xuICAgIGZuLmFkZEVudmlyb25tZW50KFwiT1JHQU5JWkFUSU9OX0lEXCIsIG9yZ2FuaXphdGlvbklkKTtcbiAgICBmbi5hZGRFbnZpcm9ubWVudChcIkFHRU5UX1NFQ1JFVF9TU01fUFJFRklYXCIsIGAvaGVyZXlhLyR7b3JnYW5pemF0aW9uSWR9L2FwcHNgKTtcbiAgICBmbi5hZGRFbnZpcm9ubWVudChcIkNPR05JVE9fVFJJR0dFUl9MQU1CREFfQVJOU1wiLCB0cmlnZ2VyQXJucy5qb2luKFwiLFwiKSk7XG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJhd3NSZWdpb25cIiwgdGhpcy5yZWdpb24pO1xuXG4gICAgaWYgKGZyb250ZW5kQXV0aG9yaXplcklkKSB7XG4gICAgICBmbi5hZGRFbnZpcm9ubWVudChcIkZST05URU5EX0FVVEhPUklaRVJfSURcIiwgZnJvbnRlbmRBdXRob3JpemVySWQpO1xuICAgIH1cbiAgICBpZiAoYXV0aEludGVncmF0aW9uSWQpIHtcbiAgICAgIGZuLmFkZEVudmlyb25tZW50KFwiQVVUSF9JTlRFR1JBVElPTl9JRFwiLCBhdXRoSW50ZWdyYXRpb25JZCk7XG4gICAgfVxuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBPcmcgTGFtYmRhOiBwZXItYXBwIGF1dGggcHJvdmlzaW9uaW5nIHBlcm1pc3Npb25zIChlbmFibGUtYXV0aCB0b29sKS5cbiAgICAvL1xuICAgIC8vIFBlci1hcHAgQ29nbml0byBwb29scyArIGNsaWVudHMgYXJlIGNyZWF0ZWQgYXQgcnVudGltZSAocmVzb3VyY2VzIGFyZVxuICAgIC8vIG9ubHkga25vd24gYWZ0ZXIgQ3JlYXRlVXNlclBvb2wgc3VjY2VlZHMpLCBzbyByZXNvdXJjZT1cIipcIi4gVGhlIG9yZ1xuICAgIC8vIExhbWJkYSBuZWVkcyB0byBhdHRhY2ggdGhlIHNoYXJlZCB0cmlnZ2VyIExhbWJkYXMgdG8gZWFjaCBuZXcgcG9vbFxuICAgIC8vIChBZGRQZXJtaXNzaW9uKSBhbmQgY2xlYW4gdGhlbSB1cCBvbiBkcm9wLXNjaGVtYSAoUmVtb3ZlUGVybWlzc2lvbikuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwiY29nbml0by1pZHA6Q3JlYXRlVXNlclBvb2xcIixcbiAgICAgICAgICBcImNvZ25pdG8taWRwOkRlbGV0ZVVzZXJQb29sXCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpVcGRhdGVVc2VyUG9vbFwiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6RGVzY3JpYmVVc2VyUG9vbFwiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6TGlzdFVzZXJQb29sc1wiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6Q3JlYXRlVXNlclBvb2xDbGllbnRcIixcbiAgICAgICAgICBcImNvZ25pdG8taWRwOkRlbGV0ZVVzZXJQb29sQ2xpZW50XCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpVcGRhdGVVc2VyUG9vbENsaWVudFwiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6RGVzY3JpYmVVc2VyUG9vbENsaWVudFwiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6QWRtaW5DcmVhdGVVc2VyXCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpMaXN0VXNlcnNcIixcbiAgICAgICAgICBcImNvZ25pdG8taWRwOlRhZ1Jlc291cmNlXCIsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wibGFtYmRhOkFkZFBlcm1pc3Npb25cIiwgXCJsYW1iZGE6UmVtb3ZlUGVybWlzc2lvblwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiB0cmlnZ2VyQXJucyxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gQ3VzdG9tIGRvbWFpbiArIEROU1xuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBpZiAoY3VzdG9tRG9tYWluICYmIGN1c3RvbURvbWFpblpvbmUpIHtcbiAgICAgIGlmICghd2lsZGNhcmRDZXJ0aWZpY2F0ZUFybikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJ3aWxkY2FyZENlcnRpZmljYXRlQXJuIGlzIHJlcXVpcmVkIHdoZW4gY3VzdG9tRG9tYWluIGlzIHNldFwiXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGNlcnRpZmljYXRlID0gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybihcbiAgICAgICAgdGhpcyxcbiAgICAgICAgXCJDZXJ0aWZpY2F0ZVwiLFxuICAgICAgICB3aWxkY2FyZENlcnRpZmljYXRlQXJuXG4gICAgICApO1xuXG4gICAgICBjb25zdCBob3N0ZWRab25lID0gcm91dGU1My5Ib3N0ZWRab25lLmZyb21Mb29rdXAodGhpcywgXCJIb3N0ZWRab25lXCIsIHtcbiAgICAgICAgZG9tYWluTmFtZTogY3VzdG9tRG9tYWluWm9uZSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBFeHBvc2UgaG9zdGVkIHpvbmUgSUQgKyBncmFudCBSb3V0ZTUzIHJlY29yZC1zZXQgbWFuYWdlbWVudCBzbyB0aGVcbiAgICAgIC8vIG9yZyBMYW1iZGEgY2FuIHdyaXRlIERLSU0gKyByZXR1cm4tcGF0aCByZWNvcmRzIHdoZW4gcHJvdmlzaW9uaW5nXG4gICAgICAvLyBwZXItYXBwIFBvc3RtYXJrIGRvbWFpbnMgdmlhIGVuYWJsZS1hdXRoLlxuICAgICAgZm4uYWRkRW52aXJvbm1lbnQoXCJIT1NURURfWk9ORV9JRFwiLCBob3N0ZWRab25lLmhvc3RlZFpvbmVJZCk7XG4gICAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICBcInJvdXRlNTM6Q2hhbmdlUmVzb3VyY2VSZWNvcmRTZXRzXCIsXG4gICAgICAgICAgICBcInJvdXRlNTM6TGlzdFJlc291cmNlUmVjb3JkU2V0c1wiLFxuICAgICAgICAgICAgXCJyb3V0ZTUzOkdldEhvc3RlZFpvbmVcIixcbiAgICAgICAgICBdLFxuICAgICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgICAgYGFybjphd3M6cm91dGU1Mzo6Omhvc3RlZHpvbmUvJHtob3N0ZWRab25lLmhvc3RlZFpvbmVJZH1gLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgICAvLyBBUEkgR2F0ZXdheSBjdXN0b20gZG9tYWluIGZvciBNQ1AgKGV4YWN0IGRvbWFpbilcbiAgICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBuZXcgYXBpZ3d2Mi5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICAgIGRvbWFpbk5hbWU6IGN1c3RvbURvbWFpbixcbiAgICAgICAgY2VydGlmaWNhdGUsXG4gICAgICB9KTtcblxuICAgICAgbmV3IGFwaWd3djIuQXBpTWFwcGluZyh0aGlzLCBcIkFwaU1hcHBpbmdcIiwge1xuICAgICAgICBhcGk6IGh0dHBBcGksXG4gICAgICAgIGRvbWFpbk5hbWUsXG4gICAgICB9KTtcblxuICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogY3VzdG9tRG9tYWluLFxuICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhcbiAgICAgICAgICBuZXcgdGFyZ2V0cy5BcGlHYXRld2F5djJEb21haW5Qcm9wZXJ0aWVzKFxuICAgICAgICAgICAgZG9tYWluTmFtZS5yZWdpb25hbERvbWFpbk5hbWUsXG4gICAgICAgICAgICBkb21haW5OYW1lLnJlZ2lvbmFsSG9zdGVkWm9uZUlkXG4gICAgICAgICAgKVxuICAgICAgICApLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgIC8vIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIGZvciBmcm9udGVuZCAoKi57Y3VzdG9tRG9tYWlufSlcbiAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgICAgaWYgKGNvZ25pdG9Vc2VyUG9vbElkICYmIGNvZ25pdG9DbGllbnRJZCkge1xuICAgICAgICBjb25zdCBjbG91ZGZyb250Q2VydGlmaWNhdGUgPSBuZXcgYWNtLkRuc1ZhbGlkYXRlZENlcnRpZmljYXRlKFxuICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgXCJDbG91ZEZyb250Q2VydGlmaWNhdGVcIixcbiAgICAgICAgICB7XG4gICAgICAgICAgICBkb21haW5OYW1lOiBgKi4ke2N1c3RvbURvbWFpbn1gLFxuICAgICAgICAgICAgaG9zdGVkWm9uZSxcbiAgICAgICAgICAgIHJlZ2lvbjogXCJ1cy1lYXN0LTFcIixcbiAgICAgICAgICB9XG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gQ2xvdWRGcm9udCBGdW5jdGlvbjogZXh0cmFjdCBhcHAgc3ViZG9tYWluIOKGkiBwcmVwZW5kIHRvIHBhdGgsIGFuZFxuICAgICAgICAvLyAod2hlbiB0aGUgb3JnIExhbWJkYSByZWdlbmVyYXRlcyB0aGUgY29kZSkgcm91dGUgY3VzdG9tIHZhbml0eVxuICAgICAgICAvLyBkb21haW5zIHZpYSBhIHBlci1ob3N0IGRvbWFpbk1hcCBsb29rdXAuXG4gICAgICAgIC8vXG4gICAgICAgIC8vIFRoaXMgaW5saW5lIGNvZGUgaXMgdGhlIEJPT1RTVFJBUCB2ZXJzaW9uIHdpdGggYW4gZW1wdHkgZG9tYWluTWFwLlxuICAgICAgICAvLyBPbiB0aGUgZmlyc3QgYHNldC1jdXN0b20tZG9tYWluc2AvYGNoZWNrLWN1c3RvbS1kb21haW5zYCBjeWNsZSB0aGVcbiAgICAgICAgLy8gb3JnIExhbWJkYSBvdmVyd3JpdGVzIHRoaXMgZnVuY3Rpb24gd2l0aCBhIHJlZ2VuZXJhdGVkIHZlcnNpb24gdGhhdFxuICAgICAgICAvLyBjb250YWlucyB0aGUgYWN0aXZlIGRvbWFpbuKGknNjaGVtYSBtYXBwaW5nLiBUaGUgc2hhcGUgbXVzdCBtYXRjaFxuICAgICAgICAvLyBzcmMvY3VzdG9tLWRvbWFpbi10ZW1wbGF0ZS50cyBpbiB0aGUgaGVyZXlhLWFwcHMgcmVwbyBzbyBydW50aW1lXG4gICAgICAgIC8vIHVwZGF0ZXMgYXJlIGRyb3AtaW4gcmVwbGFjZW1lbnRzLlxuICAgICAgICBjb25zdCBjZkZ1bmN0aW9uID0gbmV3IGNsb3VkZnJvbnQuRnVuY3Rpb24odGhpcywgXCJTdWJkb21haW5SZXdyaXRlXCIsIHtcbiAgICAgICAgICBjb2RlOiBjbG91ZGZyb250LkZ1bmN0aW9uQ29kZS5mcm9tSW5saW5lKGBcbmZ1bmN0aW9uIGhhbmRsZXIoZXZlbnQpIHtcbiAgdmFyIHJlcXVlc3QgPSBldmVudC5yZXF1ZXN0O1xuICB2YXIgaG9zdCA9IHJlcXVlc3QuaGVhZGVycy5ob3N0LnZhbHVlO1xuICB2YXIgY3VzdG9tRG9tYWluID0gJHtKU09OLnN0cmluZ2lmeShjdXN0b21Eb21haW4pfTtcbiAgdmFyIGRvbWFpbk1hcCA9IHt9O1xuICBpZiAoZG9tYWluTWFwW2hvc3RdKSB7XG4gICAgcmVxdWVzdC51cmkgPSAnLycgKyBkb21haW5NYXBbaG9zdF0gKyByZXF1ZXN0LnVyaTtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoaG9zdCAhPT0gY3VzdG9tRG9tYWluICYmIGhvc3QuZW5kc1dpdGgoJy4nICsgY3VzdG9tRG9tYWluKSkge1xuICAgIHZhciBhcHBOYW1lID0gaG9zdC5zbGljZSgwLCAtKGN1c3RvbURvbWFpbi5sZW5ndGggKyAxKSk7XG4gICAgcmVxdWVzdC51cmkgPSAnLycgKyBhcHBOYW1lICsgcmVxdWVzdC51cmk7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG4gICAgICAgICAgYCksXG4gICAgICAgICAgZnVuY3Rpb25OYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tc3ViZG9tYWluLXJld3JpdGVgLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBBUEkgR2F0ZXdheSBvcmlnaW5cbiAgICAgICAgY29uc3QgYXBpRG9tYWluTmFtZSA9IGNkay5Gbi5zZWxlY3QoXG4gICAgICAgICAgMixcbiAgICAgICAgICBjZGsuRm4uc3BsaXQoXCIvXCIsIGh0dHBBcGkuYXBpRW5kcG9pbnQpXG4gICAgICAgICk7XG5cbiAgICAgICAgY29uc3QgZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKFxuICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgXCJGcm9udGVuZERpc3RyaWJ1dGlvblwiLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGNlcnRpZmljYXRlOiBjbG91ZGZyb250Q2VydGlmaWNhdGUsXG4gICAgICAgICAgICBkb21haW5OYW1lczogW2AqLiR7Y3VzdG9tRG9tYWlufWBdLFxuICAgICAgICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XG4gICAgICAgICAgICAgIG9yaWdpbjogbmV3IG9yaWdpbnMuSHR0cE9yaWdpbihhcGlEb21haW5OYW1lLCB7XG4gICAgICAgICAgICAgICAgcHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUHJvdG9jb2xQb2xpY3kuSFRUUFNfT05MWSxcbiAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OlxuICAgICAgICAgICAgICAgIGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRCxcbiAgICAgICAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeShcbiAgICAgICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgICAgIFwiRnJvbnRlbmRPcmlnaW5Qb2xpY3lcIixcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBjb29raWVCZWhhdmlvcjpcbiAgICAgICAgICAgICAgICAgICAgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3IuYWxsb3dMaXN0KFxuICAgICAgICAgICAgICAgICAgICAgIFwiaGVyZXlhX2lkX3Rva2VuXCIsXG4gICAgICAgICAgICAgICAgICAgICAgXCJoZXJleWFfYWdlbnRcIlxuICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgaGVhZGVyQmVoYXZpb3I6XG4gICAgICAgICAgICAgICAgICAgIGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdEhlYWRlckJlaGF2aW9yLmFsbG93TGlzdChcbiAgICAgICAgICAgICAgICAgICAgICBcIkNvbnRlbnQtVHlwZVwiLFxuICAgICAgICAgICAgICAgICAgICAgIFwiQWNjZXB0LUxhbmd1YWdlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgLy8gVGhlIHN1YmRvbWFpbi1yZXdyaXRlIHZpZXdlci1yZXF1ZXN0IENGIGZ1bmN0aW9uIGNvcGllc1xuICAgICAgICAgICAgICAgICAgICAgIC8vIHRoZSB2aWV3ZXIgSG9zdCBpbnRvIHgtZm9yd2FyZGVkLWhvc3Qgc28gdGhlIGF1dGggTGFtYmRhXG4gICAgICAgICAgICAgICAgICAgICAgLy8gY2FuIHNjb3BlIHRoZSBzZXNzaW9uIGNvb2tpZSdzIERvbWFpbiBhdHRyaWJ1dGUgdG8gdGhlXG4gICAgICAgICAgICAgICAgICAgICAgLy8gaG9zdCB0aGUgdXNlciBhY3R1YWxseSB0eXBlZCAoaW5jbHVkaW5nIGN1c3RvbSB2YW5pdHlcbiAgICAgICAgICAgICAgICAgICAgICAvLyBkb21haW5zKS4gQ2xvdWRGcm9udCBzdHJpcHMgaGVhZGVycyBhZGRlZCBieSB2aWV3ZXItXG4gICAgICAgICAgICAgICAgICAgICAgLy8gcmVxdWVzdCBmdW5jdGlvbnMgYmVmb3JlIGZvcndhcmRpbmcgdG8gb3JpZ2luIHVubGVzc1xuICAgICAgICAgICAgICAgICAgICAgIC8vIHRoZXkncmUgZXhwbGljaXRseSB3aGl0ZWxpc3RlZCBoZXJlIOKAlCB3aXRob3V0IHRoaXNcbiAgICAgICAgICAgICAgICAgICAgICAvLyBlbnRyeSwgdmFuaXR5LWhvc3QgbG9naW5zIHNldCBhIGNvb2tpZSBzY29wZWQgdG8gdGhlXG4gICAgICAgICAgICAgICAgICAgICAgLy8gZGVmYXVsdCBjdXN0b21Eb21haW4gYW5kIHRoZSBicm93c2VyIHNpbGVudGx5IHJlamVjdHNcbiAgICAgICAgICAgICAgICAgICAgICAvLyBpdCAoUkZDIDYyNjUgZG9tYWluIG1pc21hdGNoKSwgYnJlYWtpbmcgbG9naW4uXG4gICAgICAgICAgICAgICAgICAgICAgXCJ4LWZvcndhcmRlZC1ob3N0XCJcbiAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5U3RyaW5nQmVoYXZpb3I6XG4gICAgICAgICAgICAgICAgICAgIGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFF1ZXJ5U3RyaW5nQmVoYXZpb3IuYWxsKCksXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uOiBjZkZ1bmN0aW9uLFxuICAgICAgICAgICAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVFVRVNULFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH1cbiAgICAgICAgKTtcblxuICAgICAgICAvLyBSb3V0ZTUzIHdpbGRjYXJkIC0+IENsb3VkRnJvbnRcbiAgICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIldpbGRjYXJkQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICAgIHpvbmU6IGhvc3RlZFpvbmUsXG4gICAgICAgICAgcmVjb3JkTmFtZTogYCouJHtjdXN0b21Eb21haW59YCxcbiAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhcbiAgICAgICAgICAgIG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQoZGlzdHJpYnV0aW9uKVxuICAgICAgICAgICksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiRnJvbnRlbmREaXN0cmlidXRpb25Eb21haW5cIiwge1xuICAgICAgICAgIHZhbHVlOiBkaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uRG9tYWluTmFtZSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgLy8gQ3VzdG9tLWRvbWFpbiBzdXBwb3J0IHdpcmluZ1xuICAgICAgICAvL1xuICAgICAgICAvLyBUaGUgb3JnIExhbWJkYSBleHBvc2VzIE1DUCB0b29scyB0aGF0IHN3YXAgdGhlIGRpc3RyaWJ1dGlvbidzXG4gICAgICAgIC8vIFZpZXdlckNlcnRpZmljYXRlIGluLXBsYWNlIHdoZW4gdXNlcnMgcmVxdWVzdCB2YW5pdHkgZG9tYWlucy4gV2U6XG4gICAgICAgIC8vICAgMS4gU2VlZCBhbiBTU00gcGFyYW0gd2l0aCB0aGUgYm9vdHN0cmFwIHdpbGRjYXJkIGNlcnQgQVJOIG9uXG4gICAgICAgIC8vICAgICAgZmlyc3QgZGVwbG95IChvblVwZGF0ZSBpcyBhIG5vLW9wIOKGkiBzdWJzZXF1ZW50IGRlcGxveXMgZG9uJ3RcbiAgICAgICAgLy8gICAgICBvdmVyd3JpdGUgdGhlIExhbWJkYSdzIGxpdmUgY2VydCBBUk4pLlxuICAgICAgICAvLyAgIDIuIEdyYW50IHRoZSBvcmcgTGFtYmRhIEFDTSAodGFnLXNjb3BlZCkgKyBDbG91ZEZyb250IChBUk4tc2NvcGVkKVxuICAgICAgICAvLyAgICAgICsgU1NNIChwYXRoLXNjb3BlZCkgcGVybWlzc2lvbnMuXG4gICAgICAgIC8vICAgMy4gUGFzcyBkaXN0cmlidXRpb24gKyBmdW5jdGlvbiBpZGVudGlmaWVycyArIFNTTSBwYXRoIHRocm91Z2ggZW52LlxuICAgICAgICAvL1xuICAgICAgICAvLyBOT1RFIG9uIGRyaWZ0OiBpZiBhIGZ1dHVyZSBDREsgc3RhY2sgY2hhbmdlIHRvdWNoZXMgdGhlIERpc3RyaWJ1dGlvblxuICAgICAgICAvLyBvciB0aGUgQ0YgZnVuY3Rpb24sIENsb3VkRm9ybWF0aW9uIHdpbGwgcmUtc2VuZCBDREsncyBpbmxpbmUgY29uZmlnXG4gICAgICAgIC8vIGFuZCBvdmVyd3JpdGUgdGhlIExhbWJkYSdzIGxpdmUgc3RhdGUuIFJlbWVkaWF0aW9uIGlzIHRvIHJlLXJ1blxuICAgICAgICAvLyBgY2hlY2stY3VzdG9tLWRvbWFpbnNgIGFmdGVyIHRoZSBzdGFjayB1cGRhdGUuXG4gICAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAgICAgY29uc3Qgdmlld2VyQ2VydFNzbVBhcmFtTmFtZSA9IGAvaGVyZXlhLyR7b3JnYW5pemF0aW9uSWR9L3ZpZXdlci1jZXJ0LWFybmA7XG4gICAgICAgIGNvbnN0IHZpZXdlckNlcnRTc21QYXJhbUFybiA9IGBhcm46YXdzOnNzbToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06cGFyYW1ldGVyJHt2aWV3ZXJDZXJ0U3NtUGFyYW1OYW1lfWA7XG5cbiAgICAgICAgY29uc3Qgc2VlZFZpZXdlckNlcnRBcm4gPSBuZXcgY3IuQXdzQ3VzdG9tUmVzb3VyY2UoXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICBcIlZpZXdlckNlcnRTc21TZWVkXCIsXG4gICAgICAgICAge1xuICAgICAgICAgICAgb25DcmVhdGU6IHtcbiAgICAgICAgICAgICAgc2VydmljZTogXCJTU01cIixcbiAgICAgICAgICAgICAgYWN0aW9uOiBcIlB1dFBhcmFtZXRlclwiLFxuICAgICAgICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgTmFtZTogdmlld2VyQ2VydFNzbVBhcmFtTmFtZSxcbiAgICAgICAgICAgICAgICBWYWx1ZTogY2xvdWRmcm9udENlcnRpZmljYXRlLmNlcnRpZmljYXRlQXJuLFxuICAgICAgICAgICAgICAgIFR5cGU6IFwiU3RyaW5nXCIsXG4gICAgICAgICAgICAgICAgT3ZlcndyaXRlOiBmYWxzZSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoXG4gICAgICAgICAgICAgICAgYHZpZXdlci1jZXJ0LXNlZWQtJHtvcmdhbml6YXRpb25JZH1gXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgIGlnbm9yZUVycm9yQ29kZXNNYXRjaGluZzogXCJQYXJhbWV0ZXJBbHJlYWR5RXhpc3RzXCIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgb25VcGRhdGU6IHtcbiAgICAgICAgICAgICAgc2VydmljZTogXCJTU01cIixcbiAgICAgICAgICAgICAgYWN0aW9uOiBcIkdldFBhcmFtZXRlclwiLFxuICAgICAgICAgICAgICBwYXJhbWV0ZXJzOiB7IE5hbWU6IHZpZXdlckNlcnRTc21QYXJhbU5hbWUgfSxcbiAgICAgICAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoXG4gICAgICAgICAgICAgICAgYHZpZXdlci1jZXJ0LXNlZWQtJHtvcmdhbml6YXRpb25JZH1gXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgIGlnbm9yZUVycm9yQ29kZXNNYXRjaGluZzogXCJQYXJhbWV0ZXJOb3RGb3VuZFwiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIG9uRGVsZXRlOiB7XG4gICAgICAgICAgICAgIHNlcnZpY2U6IFwiU1NNXCIsXG4gICAgICAgICAgICAgIGFjdGlvbjogXCJEZWxldGVQYXJhbWV0ZXJcIixcbiAgICAgICAgICAgICAgcGFyYW1ldGVyczogeyBOYW1lOiB2aWV3ZXJDZXJ0U3NtUGFyYW1OYW1lIH0sXG4gICAgICAgICAgICAgIGlnbm9yZUVycm9yQ29kZXNNYXRjaGluZzogXCJQYXJhbWV0ZXJOb3RGb3VuZFwiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHBvbGljeTogY3IuQXdzQ3VzdG9tUmVzb3VyY2VQb2xpY3kuZnJvbVN0YXRlbWVudHMoW1xuICAgICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICAgXCJzc206UHV0UGFyYW1ldGVyXCIsXG4gICAgICAgICAgICAgICAgICBcInNzbTpHZXRQYXJhbWV0ZXJcIixcbiAgICAgICAgICAgICAgICAgIFwic3NtOkRlbGV0ZVBhcmFtZXRlclwiLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbdmlld2VyQ2VydFNzbVBhcmFtQXJuXSxcbiAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICBdKSxcbiAgICAgICAgICAgIGluc3RhbGxMYXRlc3RBd3NTZGs6IGZhbHNlLFxuICAgICAgICAgIH1cbiAgICAgICAgKTtcbiAgICAgICAgc2VlZFZpZXdlckNlcnRBcm4ubm9kZS5hZGREZXBlbmRlbmN5KGNsb3VkZnJvbnRDZXJ0aWZpY2F0ZSk7XG5cbiAgICAgICAgLy8gLS0tIEFDTSAodGFnLXNjb3BlZCk6IGFueSBjZXJ0IHRoZSBvcmcgTGFtYmRhIGNyZWF0ZXMgbXVzdCBiZVxuICAgICAgICAvLyAgICAgdGFnZ2VkIHdpdGggaXRzIG93biBvcmdJZDsgYWxsIG5vbi1jcmVhdGUgYWN0aW9ucyBhcmUgZ2F0ZWQgb25cbiAgICAgICAgLy8gICAgIHRoZSBzYW1lIHRhZyBtYXRjaGluZyBvbiB0aGUgcmVzb3VyY2UuIFRoaXMgcHJldmVudHMgb3JnIEEgZnJvbVxuICAgICAgICAvLyAgICAgdG91Y2hpbmcgb3JnIEIncyBjZXJ0cy5cbiAgICAgICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgXCJhY206UmVxdWVzdENlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICAgIFwiYWNtOkFkZFRhZ3NUb0NlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICAgICAgY29uZGl0aW9uczoge1xuICAgICAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAgICAgICBcImF3czpSZXF1ZXN0VGFnL2hlcmV5YTpvcmdJZFwiOiBvcmdhbml6YXRpb25JZCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgXCJGb3JBbGxWYWx1ZXM6U3RyaW5nRXF1YWxzXCI6IHtcbiAgICAgICAgICAgICAgICBcImF3czpUYWdLZXlzXCI6IFtcbiAgICAgICAgICAgICAgICAgIFwiaGVyZXlhOm9yZ0lkXCIsXG4gICAgICAgICAgICAgICAgICBcImhlcmV5YTpzY2hlbWFcIixcbiAgICAgICAgICAgICAgICAgIFwiaGVyZXlhOmRvbWFpbnNcIixcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KVxuICAgICAgICApO1xuICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICBcImFjbTpEZXNjcmliZUNlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICAgIFwiYWNtOkRlbGV0ZUNlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICAgIFwiYWNtOkxpc3RUYWdzRm9yQ2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAgICAgYGFybjphd3M6YWNtOnVzLWVhc3QtMToke3RoaXMuYWNjb3VudH06Y2VydGlmaWNhdGUvKmAsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgY29uZGl0aW9uczoge1xuICAgICAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAgICAgICBcImF3czpSZXNvdXJjZVRhZy9oZXJleWE6b3JnSWRcIjogb3JnYW5pemF0aW9uSWQsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pXG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gLS0tIENsb3VkRnJvbnQgKEFSTi1zY29wZWQpOiB0aGUgb3JnIExhbWJkYSBtYXkgb25seSB1cGRhdGUgSVRTXG4gICAgICAgIC8vICAgICBvd24gZGlzdHJpYnV0aW9uIGFuZCBmdW5jdGlvbi5cbiAgICAgICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgXCJjbG91ZGZyb250OkdldERpc3RyaWJ1dGlvblwiLFxuICAgICAgICAgICAgICBcImNsb3VkZnJvbnQ6R2V0RGlzdHJpYnV0aW9uQ29uZmlnXCIsXG4gICAgICAgICAgICAgIFwiY2xvdWRmcm9udDpVcGRhdGVEaXN0cmlidXRpb25cIixcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAgICAgYGFybjphd3M6Y2xvdWRmcm9udDo6JHt0aGlzLmFjY291bnR9OmRpc3RyaWJ1dGlvbi8ke2Rpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25JZH1gLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9KVxuICAgICAgICApO1xuICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICBcImNsb3VkZnJvbnQ6R2V0RnVuY3Rpb25cIixcbiAgICAgICAgICAgICAgXCJjbG91ZGZyb250OkRlc2NyaWJlRnVuY3Rpb25cIixcbiAgICAgICAgICAgICAgXCJjbG91ZGZyb250OlVwZGF0ZUZ1bmN0aW9uXCIsXG4gICAgICAgICAgICAgIFwiY2xvdWRmcm9udDpQdWJsaXNoRnVuY3Rpb25cIixcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAgICAgYGFybjphd3M6Y2xvdWRmcm9udDo6JHt0aGlzLmFjY291bnR9OmZ1bmN0aW9uLyR7Y2ZGdW5jdGlvbi5mdW5jdGlvbk5hbWV9YCxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSlcbiAgICAgICAgKTtcblxuICAgICAgICAvLyAtLS0gU1NNIChwYXRoLXNjb3BlZCk6IHdyaXRlIHRoZSBjZXJ0IEFSTiBvbiBzd2FwLlxuICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1wic3NtOkdldFBhcmFtZXRlclwiLCBcInNzbTpQdXRQYXJhbWV0ZXJcIl0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFt2aWV3ZXJDZXJ0U3NtUGFyYW1Bcm5dLFxuICAgICAgICAgIH0pXG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gLS0tIEV4cG9zZSBJRHMgdG8gdGhlIG9yZyBMYW1iZGEuXG4gICAgICAgIGZuLmFkZEVudmlyb25tZW50KFxuICAgICAgICAgIFwiQ0xPVURGUk9OVF9ESVNUUklCVVRJT05fSURcIixcbiAgICAgICAgICBkaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uSWRcbiAgICAgICAgKTtcbiAgICAgICAgZm4uYWRkRW52aXJvbm1lbnQoXCJDTE9VREZST05UX0ZVTkNUSU9OX05BTUVcIiwgY2ZGdW5jdGlvbi5mdW5jdGlvbk5hbWUpO1xuICAgICAgICBmbi5hZGRFbnZpcm9ubWVudChcbiAgICAgICAgICBcIkNMT1VERlJPTlRfRE9NQUlOXCIsXG4gICAgICAgICAgZGlzdHJpYnV0aW9uLmRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVcbiAgICAgICAgKTtcbiAgICAgICAgZm4uYWRkRW52aXJvbm1lbnQoXCJWSUVXRVJfQ0VSVF9TU01fUEFSQU1cIiwgdmlld2VyQ2VydFNzbVBhcmFtTmFtZSk7XG4gICAgICAgIGZuLm5vZGUuYWRkRGVwZW5kZW5jeShzZWVkVmlld2VyQ2VydEFybik7XG4gICAgICB9XG5cbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiU2VydmljZVVybFwiLCB7XG4gICAgICAgIHZhbHVlOiBgaHR0cHM6Ly8ke2N1c3RvbURvbWFpbn1gLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiU2VydmljZVVybFwiLCB7XG4gICAgICAgIHZhbHVlOiBodHRwQXBpLmFwaUVuZHBvaW50LFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3REb21haW5ab25lKFxuICBjdXN0b21Eb21haW46IHN0cmluZyB8IHVuZGVmaW5lZFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFjdXN0b21Eb21haW4pIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHBhcnRzID0gY3VzdG9tRG9tYWluLnNwbGl0KFwiLlwiKTtcbiAgaWYgKHBhcnRzLmxlbmd0aCA8IDIpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgZG9tYWluIG5hbWU6IFwiICsgY3VzdG9tRG9tYWluKTtcbiAgcmV0dXJuIHBhcnRzLmxlbmd0aCA9PT0gMiA/IGN1c3RvbURvbWFpbiA6IHBhcnRzLnNsaWNlKDEpLmpvaW4oXCIuXCIpO1xufVxuIl19