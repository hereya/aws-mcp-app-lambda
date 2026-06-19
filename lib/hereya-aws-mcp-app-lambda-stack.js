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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGVyZXlhLWF3cy1tY3AtYXBwLWxhbWJkYS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImhlcmV5YS1hd3MtbWNwLWFwcC1sYW1iZGEtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsc0RBQXdDO0FBQ3hDLDJDQUErQztBQUMvQywrREFBaUQ7QUFDakQsc0VBQXdEO0FBQ3hELHdGQUEwRTtBQUMxRSx3RUFBMEQ7QUFDMUQseURBQTJDO0FBQzNDLGlFQUFtRDtBQUNuRCx5RUFBMkQ7QUFDM0Qsd0VBQTBEO0FBQzFELHNGQUF3RTtBQUN4RSx1RUFBeUQ7QUFDekQsNEVBQThEO0FBQzlELGlFQUFtRDtBQUNuRCxtRUFBcUQ7QUFFckQsMkNBQTZCO0FBRTdCLE1BQWEsMEJBQTJCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDdkQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLG9CQUFvQixHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsc0JBQXNCLENBQUMsQ0FBQztRQUNqRSxJQUFJLENBQUMsb0JBQW9CLEVBQUUsQ0FBQztZQUMxQixNQUFNLElBQUksS0FBSyxDQUFDLHVEQUF1RCxDQUFDLENBQUM7UUFDM0UsQ0FBQztRQUVELE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztRQUNyRCxJQUFJLENBQUMsY0FBYyxFQUFFLENBQUM7WUFDcEIsTUFBTSxJQUFJLEtBQUssQ0FBQyxpREFBaUQsQ0FBQyxDQUFDO1FBQ3JFLENBQUM7UUFFRCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixDQUFDLENBQUM7UUFDckQsSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO1lBQ3BCLE1B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cnQgeyBTZWNyZXRWYWx1ZSB9IGZyb20gXCJhd3MtY2RrLWxpYi9jb3JlXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIHNlY3JldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zZWNyZXRzbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnRcIjtcbmltcG9ydCAqIGFzIG9yaWdpbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250LW9yaWdpbnNcIjtcbmltcG9ydCAqIGFzIGNyIGZyb20gXCJhd3MtY2RrLWxpYi9jdXN0b20tcmVzb3VyY2VzXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwicGF0aFwiO1xuXG5leHBvcnQgY2xhc3MgSGVyZXlhQXdzTWNwQXBwTGFtYmRhU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCBoZXJleWFQcm9qZWN0Um9vdERpciA9IHByb2Nlc3MuZW52W1wiaGVyZXlhUHJvamVjdFJvb3REaXJcIl07XG4gICAgaWYgKCFoZXJleWFQcm9qZWN0Um9vdERpcikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiaGVyZXlhUHJvamVjdFJvb3REaXIgZW52aXJvbm1lbnQgdmFyaWFibGUgaXMgcmVxdWlyZWRcIik7XG4gICAgfVxuXG4gICAgY29uc3Qgb2F1dGhTZXJ2ZXJVcmwgPSBwcm9jZXNzLmVudltcIm9hdXRoU2VydmVyVXJsXCJdO1xuICAgIGlmICghb2F1dGhTZXJ2ZXJVcmwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIm9hdXRoU2VydmVyVXJsIGVudmlyb25tZW50IHZhcmlhYmxlIGlzIHJlcXVpcmVkXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IG9yZ2FuaXphdGlvbklkID0gcHJvY2Vzcy5lbnZbXCJvcmdhbml6YXRpb25JZFwiXTtcbiAgICBpZiAoIW9yZ2FuaXphdGlvbklkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJvcmdhbml6YXRpb25JZCBlbnZpcm9ubWVudCB2YXJpYWJsZSBpcyByZXF1aXJlZFwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBtZW1vcnlTaXplID0gcHJvY2Vzcy5lbnZbXCJtZW1vcnlTaXplXCJdXG4gICAgICA/IHBhcnNlSW50KHByb2Nlc3MuZW52W1wibWVtb3J5U2l6ZVwiXSlcbiAgICAgIDogMjU2O1xuICAgIGNvbnN0IHRpbWVvdXQgPSBwcm9jZXNzLmVudltcInRpbWVvdXRcIl1cbiAgICAgID8gcGFyc2VJbnQocHJvY2Vzcy5lbnZbXCJ0aW1lb3V0XCJdKVxuICAgICAgOiAzMDtcbiAgICBjb25zdCBoYW5kbGVyTmFtZSA9IHByb2Nlc3MuZW52W1wiaGFuZGxlclwiXSA/PyBcImhhbmRsZXIuaGFuZGxlclwiO1xuICAgIGNvbnN0IGN1c3RvbURvbWFpbiA9IHByb2Nlc3MuZW52W1wiY3VzdG9tRG9tYWluXCJdO1xuICAgIGNvbnN0IGN1c3RvbURvbWFpblpvbmUgPVxuICAgICAgcHJvY2Vzcy5lbnZbXCJjdXN0b21Eb21haW5ab25lXCJdID8/IGV4dHJhY3REb21haW5ab25lKGN1c3RvbURvbWFpbik7XG4gICAgY29uc3Qgd2lsZGNhcmRDZXJ0aWZpY2F0ZUFybiA9IHByb2Nlc3MuZW52W1wid2lsZGNhcmRDZXJ0aWZpY2F0ZUFyblwiXTtcblxuICAgIC8vIFBhcnNlIGhlcmV5YVByb2plY3RFbnZcbiAgICBjb25zdCBlbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSBKU09OLnBhcnNlKFxuICAgICAgcHJvY2Vzcy5lbnZbXCJoZXJleWFQcm9qZWN0RW52XCJdID8/IFwie31cIlxuICAgICk7XG5cbiAgICAvLyBTZXBhcmF0ZSBJQU0gcG9saWN5IGVudiB2YXJzXG4gICAgY29uc3QgcG9saWN5RW52ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgT2JqZWN0LmVudHJpZXMoZW52KS5maWx0ZXIoXG4gICAgICAgIChba2V5XSkgPT4ga2V5LnN0YXJ0c1dpdGgoXCJJQU1fUE9MSUNZX1wiKSB8fCBrZXkuc3RhcnRzV2l0aChcImlhbVBvbGljeVwiKVxuICAgICAgKVxuICAgICk7XG5cbiAgICBjb25zdCBub25Qb2xpY3lFbnYgPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICBPYmplY3QuZW50cmllcyhlbnYpLmZpbHRlcihcbiAgICAgICAgKFtrZXldKSA9PlxuICAgICAgICAgICFrZXkuc3RhcnRzV2l0aChcIklBTV9QT0xJQ1lfXCIpICYmICFrZXkuc3RhcnRzV2l0aChcImlhbVBvbGljeVwiKVxuICAgICAgKVxuICAgICk7XG5cbiAgICAvLyBTZXBhcmF0ZSBzZWNyZXQgZW52IHZhcnMgKHNlY3JldDovLyBwcmVmaXgpXG4gICAgY29uc3Qgc2VjcmV0RW52RW50cmllcyA9IE9iamVjdC5lbnRyaWVzKG5vblBvbGljeUVudilcbiAgICAgIC5maWx0ZXIoKFssIHZhbHVlXSkgPT4gKHZhbHVlIGFzIHN0cmluZykuc3RhcnRzV2l0aChcInNlY3JldDovL1wiKSlcbiAgICAgIC5tYXAoKFtrZXksIHZhbHVlXSkgPT4ge1xuICAgICAgICBjb25zdCBwbGFpblZhbHVlID0gKHZhbHVlIGFzIHN0cmluZykuc3BsaXQoXCJzZWNyZXQ6Ly9cIilbMV07XG4gICAgICAgIGNvbnN0IHNlY3JldE5hbWUgPSBgLyR7dGhpcy5zdGFja05hbWV9LyR7a2V5fWA7XG4gICAgICAgIGNvbnN0IHNlY3JldCA9IG5ldyBzZWNyZXRzLlNlY3JldCh0aGlzLCBrZXksIHtcbiAgICAgICAgICBzZWNyZXROYW1lLFxuICAgICAgICAgIHNlY3JldFN0cmluZ1ZhbHVlOiBTZWNyZXRWYWx1ZS51bnNhZmVQbGFpblRleHQocGxhaW5WYWx1ZSksXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBrZXksIHNlY3JldCwgc2VjcmV0TmFtZSB9O1xuICAgICAgfSk7XG5cbiAgICBjb25zdCBwbGFpbkVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIE9iamVjdC5lbnRyaWVzKG5vblBvbGljeUVudikuZmlsdGVyKFxuICAgICAgICAoWywgdmFsdWVdKSA9PiAhKHZhbHVlIGFzIHN0cmluZykuc3RhcnRzV2l0aChcInNlY3JldDovL1wiKVxuICAgICAgKVxuICAgICk7XG5cblxuICAgIC8vIENvZ25pdG8gY29uZmlnIChmcm9tIGF3cy9jb2duaXRvIHBhY2thZ2Ugb3V0cHV0cyB2aWEgaGVyZXlhUHJvamVjdEVudilcbiAgICBjb25zdCBjb2duaXRvVXNlclBvb2xJZCA9IHBsYWluRW52W1widXNlclBvb2xJZFwiXSA/PyBub25Qb2xpY3lFbnZbXCJ1c2VyUG9vbElkXCJdO1xuICAgIGNvbnN0IGNvZ25pdG9DbGllbnRJZCA9IHBsYWluRW52W1widXNlclBvb2xDbGllbnRJZFwiXSA/PyBub25Qb2xpY3lFbnZbXCJ1c2VyUG9vbENsaWVudElkXCJdO1xuICAgIGNvbnN0IGNvZ25pdG9SZWdpb24gPSBwbGFpbkVudltcImF3c0NvZ25pdG9SZWdpb25cIl0gPz8gbm9uUG9saWN5RW52W1wiYXdzQ29nbml0b1JlZ2lvblwiXSA/PyBwcm9jZXNzLmVudltcIkNES19ERUZBVUxUX1JFR0lPTlwiXSA/PyBcInVzLWVhc3QtMVwiO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBMYW1iZGEgbmFtaW5nIHByZWZpeCBmb3IgcGVyLWFwcCBMYW1iZGFzIChkZXJpdmVkIGZyb20gY3VzdG9tRG9tYWluKVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBjb25zdCBvcmdQcmVmaXggPSBjdXN0b21Eb21haW5cbiAgICAgID8gY3VzdG9tRG9tYWluLnNwbGl0KFwiLlwiKVswXVxuICAgICAgOiB0aGlzLnN0YWNrTmFtZS5zdWJzdHJpbmcoMCwgMjApO1xuICAgIGNvbnN0IGFwcExhbWJkYU5hbWVQcmVmaXggPSBgJHtvcmdQcmVmaXh9LWFwcC1gO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBMYW1iZGEgMTogQXBwIEhhbmRsZXIgKE9yZyBMYW1iZGEg4oCUIE1DUCBvbmx5KVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAvLyBQYXNzIGRlcGxveS10aW1lIGNvbmZpZyB2YXJzIHRvIHRoZSBoYW5kbGVyIChub3QgaW4gaGVyZXlhUHJvamVjdEVudilcbiAgICBpZiAoY3VzdG9tRG9tYWluKSB7XG4gICAgICBwbGFpbkVudltcImN1c3RvbURvbWFpblwiXSA9IGN1c3RvbURvbWFpbjtcbiAgICB9XG5cbiAgICBjb25zdCBmbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJIYW5kbGVyXCIsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YLFxuICAgICAgaGFuZGxlcjogaGFuZGxlck5hbWUsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKGhlcmV5YVByb2plY3RSb290RGlyLCBcImRpc3RcIikpLFxuICAgICAgbWVtb3J5U2l6ZSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKHRpbWVvdXQpLFxuICAgICAgZW52aXJvbm1lbnQ6IHBsYWluRW52LFxuICAgIH0pO1xuXG4gICAgLy8gQXR0YWNoIHNlY3JldCByZWZlcmVuY2VzIChzZWNyZXQgbmFtZSwgbm90IHZhbHVlKSBhbmQgZ3JhbnQgcmVhZCBhY2Nlc3NcbiAgICBjb25zdCBzZWNyZXRLZXlzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgeyBrZXksIHNlY3JldCwgc2VjcmV0TmFtZSB9IG9mIHNlY3JldEVudkVudHJpZXMpIHtcbiAgICAgIGZuLmFkZEVudmlyb25tZW50KGtleSwgc2VjcmV0TmFtZSk7XG4gICAgICBzZWNyZXQuZ3JhbnRSZWFkKGZuKTtcbiAgICAgIHNlY3JldEtleXMucHVzaChrZXkpO1xuICAgIH1cbiAgICBpZiAoc2VjcmV0S2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICBmbi5hZGRFbnZpcm9ubWVudChcIlNFQ1JFVF9LRVlTXCIsIHNlY3JldEtleXMuam9pbihcIixcIikpO1xuICAgIH1cblxuICAgIC8vIEF0dGFjaCBJQU0gcG9saWNpZXMgZnJvbSBkZXBlbmRlbmN5IHBhY2thZ2VzXG4gICAgZm9yIChjb25zdCBbLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocG9saWN5RW52KSkge1xuICAgICAgY29uc3QgcG9saWN5ID0gSlNPTi5wYXJzZSh2YWx1ZSBhcyBzdHJpbmcpO1xuICAgICAgZm9yIChjb25zdCBzdGF0ZW1lbnQgb2YgcG9saWN5LlN0YXRlbWVudCkge1xuICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3koaWFtLlBvbGljeVN0YXRlbWVudC5mcm9tSnNvbihzdGF0ZW1lbnQpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIFNoYXJlZCBJQU0gUm9sZSBmb3IgcGVyLWFwcCBMYW1iZGFzXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IGFwcExhbWJkYVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgXCJBcHBMYW1iZGFSb2xlXCIsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwibGFtYmRhLmFtYXpvbmF3cy5jb21cIiksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbU1hbmFnZWRQb2xpY3lBcm4oXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICBcIkFwcExhbWJkYUJhc2ljRXhlY1wiLFxuICAgICAgICAgIFwiYXJuOmF3czppYW06OmF3czpwb2xpY3kvc2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZVwiXG4gICAgICAgICksXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gQXBwbHkgc2FtZSBJQU0gcG9saWNpZXMgZnJvbSBkZXBlbmRlbmN5IHBhY2thZ2VzIChBdXJvcmEsIFMzLCBldGMuKVxuICAgIGZvciAoY29uc3QgWywgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHBvbGljeUVudikpIHtcbiAgICAgIGNvbnN0IHBvbGljeSA9IEpTT04ucGFyc2UodmFsdWUgYXMgc3RyaW5nKTtcbiAgICAgIGZvciAoY29uc3Qgc3RhdGVtZW50IG9mIHBvbGljeS5TdGF0ZW1lbnQpIHtcbiAgICAgICAgYXBwTGFtYmRhUm9sZS5hZGRUb1BvbGljeShpYW0uUG9saWN5U3RhdGVtZW50LmZyb21Kc29uKHN0YXRlbWVudCkpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gTGFtYmRhIExheWVyIGZvciBwZXItYXBwIHJ1bnRpbWUgdXRpbGl0aWVzXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IHJ1bnRpbWVMYXllciA9IG5ldyBsYW1iZGEuTGF5ZXJWZXJzaW9uKHRoaXMsIFwiQXBwUnVudGltZUxheWVyXCIsIHtcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcbiAgICAgICAgcGF0aC5qb2luKGhlcmV5YVByb2plY3RSb290RGlyLCBcImRpc3RcIiwgXCJsYXllclwiKVxuICAgICAgKSxcbiAgICAgIGNvbXBhdGlibGVSdW50aW1lczogW2xhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YXSxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkhlcmV5YSBydW50aW1lIChkYiwgc3RvcmFnZSkgZm9yIHBlci1hcHAgTGFtYmRhc1wiLFxuICAgIH0pO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBQZXItYXBwIGF1dGg6IHNoYXJlZCBtdWx0aS10ZW5hbnQgQ29nbml0byB0cmlnZ2VycyArIE9UUCB0YWJsZS5cbiAgICAvL1xuICAgIC8vIGBlbmFibGUtYXV0aGAgcHJvdmlzaW9ucyBhIGRlZGljYXRlZCBDb2duaXRvIHVzZXIgcG9vbCBwZXIgYXBwLiBBbGxcbiAgICAvLyBwb29scyBhY3Jvc3MgdGhlIG9yZyBhcmUgd2lyZWQgdG8gdGhlIHNhbWUgNCBjaGFsbGVuZ2UgdHJpZ2dlciBMYW1iZGFzXG4gICAgLy8gZGVjbGFyZWQgaGVyZSDigJQgdGhlIHRyaWdnZXJzIGFyZSBwb29sLWFnbm9zdGljICh0aGV5IHJlYWRcbiAgICAvLyBldmVudC51c2VyUG9vbElkIGF0IHJ1bnRpbWUpLiBUaGUgT1RQIHRhYmxlIGlzIGtleWVkIGJ5XG4gICAgLy8gKHBvb2xfaWQsIGVtYWlsKSBzbyBjb25jdXJyZW50IGxvZ2lucyBhY3Jvc3MgcG9vbHMgY2FuJ3QgY29sbGlkZS5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3Qgb3RwVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJBcHBBdXRoT3RwVGFibGVcIiwge1xuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6IFwicG9vbF9pZFwiLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6IFwiZW1haWxcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcInR0bFwiLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHRyaWdnZXJFbnYgPSB7IE9UUF9UQUJMRV9OQU1FOiBvdHBUYWJsZS50YWJsZU5hbWUgfTtcbiAgICBjb25zdCBtYWtlVHJpZ2dlciA9IChpZDogc3RyaW5nLCBkaXI6IHN0cmluZykgPT5cbiAgICAgIG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgaWQsIHtcbiAgICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoXG4gICAgICAgICAgcGF0aC5qb2luKF9fZGlybmFtZSwgXCJjb2duaXRvLXRyaWdnZXJzXCIsIGRpcilcbiAgICAgICAgKSxcbiAgICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgICAgIGVudmlyb25tZW50OiB0cmlnZ2VyRW52LFxuICAgICAgfSk7XG5cbiAgICBjb25zdCBwcmVTaWduVXBGbiA9IG1ha2VUcmlnZ2VyKFwiUHJlU2lnblVwVHJpZ2dlclwiLCBcInByZS1zaWduLXVwXCIpO1xuICAgIGNvbnN0IGRlZmluZUNoYWxsZW5nZUZuID0gbWFrZVRyaWdnZXIoXG4gICAgICBcIkRlZmluZUF1dGhDaGFsbGVuZ2VUcmlnZ2VyXCIsXG4gICAgICBcImRlZmluZS1hdXRoLWNoYWxsZW5nZVwiXG4gICAgKTtcbiAgICBjb25zdCBjcmVhdGVDaGFsbGVuZ2VGbiA9IG1ha2VUcmlnZ2VyKFxuICAgICAgXCJDcmVhdGVBdXRoQ2hhbGxlbmdlVHJpZ2dlclwiLFxuICAgICAgXCJjcmVhdGUtYXV0aC1jaGFsbGVuZ2VcIlxuICAgICk7XG4gICAgY29uc3QgdmVyaWZ5Q2hhbGxlbmdlRm4gPSBtYWtlVHJpZ2dlcihcbiAgICAgIFwiVmVyaWZ5QXV0aENoYWxsZW5nZVRyaWdnZXJcIixcbiAgICAgIFwidmVyaWZ5LWF1dGgtY2hhbGxlbmdlXCJcbiAgICApO1xuXG4gICAgb3RwVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGNyZWF0ZUNoYWxsZW5nZUZuKTtcbiAgICBvdHBUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEodmVyaWZ5Q2hhbGxlbmdlRm4pO1xuXG4gICAgLy8gVmVyaWZ5IHRyaWdnZXIgYWxzbyB1cGRhdGVzIHRoZSBDb2duaXRvIHVzZXIgYXR0cmlidXRlIGBlbWFpbF92ZXJpZmllZGAuXG4gICAgLy8gU2NvcGluZyB0byByZXNvdXJjZT1cIipcIiBiZWNhdXNlIHBlci1hcHAgcG9vbHMgYXJlIGNyZWF0ZWQgYXQgcnVudGltZSBieVxuICAgIC8vIHRoZSBvcmcgTGFtYmRhIOKAlCB3ZSBjYW4ndCBwaW4gYSBzaW5nbGUgQVJOIGF0IHN0YWNrIGRlcGxveSB0aW1lLlxuICAgIHZlcmlmeUNoYWxsZW5nZUZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wiY29nbml0by1pZHA6QWRtaW5VcGRhdGVVc2VyQXR0cmlidXRlc1wiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgY29uc3QgdHJpZ2dlckFybnMgPSBbXG4gICAgICBwcmVTaWduVXBGbi5mdW5jdGlvbkFybixcbiAgICAgIGRlZmluZUNoYWxsZW5nZUZuLmZ1bmN0aW9uQXJuLFxuICAgICAgY3JlYXRlQ2hhbGxlbmdlRm4uZnVuY3Rpb25Bcm4sXG4gICAgICB2ZXJpZnlDaGFsbGVuZ2VGbi5mdW5jdGlvbkFybixcbiAgICBdO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBNQ1AgT0F1dGggQXV0aG9yaXplciBMYW1iZGFcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3QgYXV0aG9yaXplckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIkF1dGhvcml6ZXJIYW5kbGVyXCIsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YLFxuICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgXCJhdXRob3JpemVyXCIpKSxcbiAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEwKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIE9BVVRIX1NFUlZFUl9VUkw6IG9hdXRoU2VydmVyVXJsLFxuICAgICAgICBCT1VORF9PUkdfSUQ6IG9yZ2FuaXphdGlvbklkLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGh0dHBBdXRob3JpemVyID0gbmV3IGF1dGhvcml6ZXJzLkh0dHBMYW1iZGFBdXRob3JpemVyKFxuICAgICAgXCJIZXJleWFBdXRob3JpemVyXCIsXG4gICAgICBhdXRob3JpemVyRm4sXG4gICAgICB7XG4gICAgICAgIHJlc3BvbnNlVHlwZXM6IFthdXRob3JpemVycy5IdHRwTGFtYmRhUmVzcG9uc2VUeXBlLlNJTVBMRV0sXG4gICAgICAgIHJlc3VsdHNDYWNoZVR0bDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gSFRUUCBBUElcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3QgaHR0cEFwaSA9IG5ldyBhcGlnd3YyLkh0dHBBcGkodGhpcywgXCJIdHRwQXBpXCIsIHtcbiAgICAgIGFwaU5hbWU6IHRoaXMuc3RhY2tOYW1lLFxuICAgIH0pO1xuXG4gICAgY29uc3QgbGFtYmRhSW50ZWdyYXRpb24gPSBuZXcgaW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgIFwiTGFtYmRhSW50ZWdyYXRpb25cIixcbiAgICAgIGZuXG4gICAgKTtcblxuICAgIC8vIENvbXB1dGUgc2VydmljZSBVUkwgZm9yIFBSTSAoY3VzdG9tIGRvbWFpbiBvciBBUEkgZW5kcG9pbnQpXG4gICAgY29uc3Qgc2VydmljZVVybCA9IGN1c3RvbURvbWFpblxuICAgICAgPyBgaHR0cHM6Ly8ke2N1c3RvbURvbWFpbn1gXG4gICAgICA6IGh0dHBBcGkuYXBpRW5kcG9pbnQ7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIFByb3RlY3RlZCBSZXNvdXJjZSBNZXRhZGF0YSAoUkZDIDk3MjgpXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IHBybUxhbWJkYSA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJQcm1IYW5kbGVyXCIsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YLFxuICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbiAgICAgICAgZXhwb3J0cy5oYW5kbGVyID0gYXN5bmMgKCkgPT4gKHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgICAgICAgICBcIkNhY2hlLUNvbnRyb2xcIjogXCJwdWJsaWMsIG1heC1hZ2U9MzYwMFwiLFxuICAgICAgICAgICAgXCJBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogXCIqXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICByZXNvdXJjZTogcHJvY2Vzcy5lbnYuU0VSVklDRV9VUkwgKyBcIi9tY3BcIixcbiAgICAgICAgICAgIGF1dGhvcml6YXRpb25fc2VydmVyczogW3Byb2Nlc3MuZW52Lk9BVVRIX1NFUlZFUl9VUkwgKyBcIi9vYXV0aC9cIiArIHByb2Nlc3MuZW52Lk9SR0FOSVpBVElPTl9JRF0sXG4gICAgICAgICAgICBiZWFyZXJfbWV0aG9kc19zdXBwb3J0ZWQ6IFtcImhlYWRlclwiXSxcbiAgICAgICAgICAgIHNjb3Blc19zdXBwb3J0ZWQ6IFtcIm1jcDphY2Nlc3NcIl0sXG4gICAgICAgICAgfSksXG4gICAgICAgIH0pO1xuICAgICAgYCksXG4gICAgICBtZW1vcnlTaXplOiAxMjgsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg1KSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFNFUlZJQ0VfVVJMOiBzZXJ2aWNlVXJsLFxuICAgICAgICBPQVVUSF9TRVJWRVJfVVJMOiBvYXV0aFNlcnZlclVybCxcbiAgICAgICAgT1JHQU5JWkFUSU9OX0lEOiBvcmdhbml6YXRpb25JZCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBodHRwQXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiBcIi8ud2VsbC1rbm93bi9vYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2VcIixcbiAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBuZXcgaW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICAgXCJQcm1JbnRlZ3JhdGlvblwiLFxuICAgICAgICBwcm1MYW1iZGFcbiAgICAgICksXG4gICAgfSk7XG5cbiAgICAvLyBNQ1Agcm91dGUgKGV4aXN0aW5nKVxuICAgIGh0dHBBcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiL21jcFwiLFxuICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiBsYW1iZGFJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IGh0dHBBdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgLy8gQWxsb3cgQVBJIEdhdGV3YXkgdG8gaW52b2tlIHRoZSBvcmcgTGFtYmRhIG9uIEFOWSByb3V0ZSBvZiB0aGlzIEFQSS5cbiAgICAvLyBIdHRwTGFtYmRhSW50ZWdyYXRpb24gb25seSBncmFudHMgYSByb3V0ZS1zcGVjaWZpYyBwZXJtaXNzaW9uIGZvciAvbWNwLFxuICAgIC8vIGJ1dCB0aGUgb3JnIExhbWJkYSBjcmVhdGVzIGFkZGl0aW9uYWwgcm91dGVzIGF0IHJ1bnRpbWUgdGhhdCB0YXJnZXRcbiAgICAvLyBpdHNlbGYgKGUuZy4gcGVyLWFwcCBUZWxlZ3JhbSB3ZWJob29rcyBhdCAve3NjaGVtYX0vdGVsZWdyYW0ve3Byb3h5K30pLlxuICAgIC8vIFdpdGhvdXQgYW4gYXBpLXNjb3BlZCBwZXJtaXNzaW9uIHRob3NlIHJvdXRlcyByZXR1cm4gNTAwIChBUEkgR2F0ZXdheVxuICAgIC8vIGNhbm5vdCBpbnZva2UgdGhlIExhbWJkYSksIGFuZCB0aGUgb3JnIExhbWJkYSBjYW5ub3Qgc2VsZi1ncmFudFxuICAgIC8vIChpdHMgbGFtYmRhOkFkZFBlcm1pc3Npb24gSUFNIGlzIHNjb3BlZCB0byBwZXItYXBwIGZ1bmN0aW9uIG5hbWVzIG9ubHkpLlxuICAgIGZuLmFkZFBlcm1pc3Npb24oXCJIdHRwQXBpSW52b2tlQWxsXCIsIHtcbiAgICAgIHByaW5jaXBhbDogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiYXBpZ2F0ZXdheS5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgc291cmNlQXJuOiBgYXJuOmF3czpleGVjdXRlLWFwaToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06JHtodHRwQXBpLmFwaUlkfS8qLypgLFxuICAgIH0pO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBGcm9udGVuZCBBdXRob3JpemVyICsgQXV0aCBMYW1iZGEgKGZvciBwZXItYXBwIExhbWJkYXMpXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIFRoZXNlIGFyZSBjcmVhdGVkIGF0IENESyB0aW1lLiBUaGVpciBJRHMgYXJlIHBhc3NlZCB0byB0aGUgb3JnIExhbWJkYVxuICAgIC8vIHNvIGl0IGNhbiBjcmVhdGUgcGVyLWFwcCBBUEkgR2F0ZXdheSByb3V0ZXMgZHluYW1pY2FsbHkuXG5cbiAgICBsZXQgZnJvbnRlbmRBdXRob3JpemVySWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgYXV0aEludGVncmF0aW9uSWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcblxuICAgIGlmIChjb2duaXRvVXNlclBvb2xJZCAmJiBjb2duaXRvQ2xpZW50SWQpIHtcbiAgICAgIC8vIEZyb250ZW5kIEF1dGhvcml6ZXIgTGFtYmRhIChtdWx0aS10ZW5hbnQ6IHBlci1hcHAgcG9vbCBsb29rdXAgdmlhIERCLFxuICAgICAgLy8gd2l0aCBzaGFyZWQtcG9vbCBmYWxsYmFjayBmb3IgUGhhc2UtQSBtaWdyYXRpb24pLlxuICAgICAgY29uc3QgZnJvbnRlbmRBdXRob3JpemVyRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKFxuICAgICAgICB0aGlzLFxuICAgICAgICBcIkZyb250ZW5kQXV0aG9yaXplckhhbmRsZXJcIixcbiAgICAgICAge1xuICAgICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YLFxuICAgICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcbiAgICAgICAgICAgIHBhdGguam9pbihfX2Rpcm5hbWUsIFwiZnJvbnRlbmQtYXV0aG9yaXplclwiKVxuICAgICAgICAgICksXG4gICAgICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEwKSxcbiAgICAgICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAgICAgQ09HTklUT19VU0VSX1BPT0xfSUQ6IGNvZ25pdG9Vc2VyUG9vbElkLFxuICAgICAgICAgICAgQ09HTklUT19SRUdJT046IGNvZ25pdG9SZWdpb24sXG4gICAgICAgICAgICBjbHVzdGVyQXJuOiBwbGFpbkVudltcImNsdXN0ZXJBcm5cIl0gPz8gXCJcIixcbiAgICAgICAgICAgIHNlY3JldEFybjogcGxhaW5FbnZbXCJzZWNyZXRBcm5cIl0gPz8gXCJcIixcbiAgICAgICAgICAgIGRhdGFiYXNlTmFtZTogcGxhaW5FbnZbXCJkYXRhYmFzZU5hbWVcIl0gPz8gXCJcIixcbiAgICAgICAgICB9LFxuICAgICAgICB9XG4gICAgICApO1xuXG4gICAgICAvLyBBcHBseSBBdXJvcmEgRGF0YSBBUEkgcG9saWNpZXMgZnJvbSBkZXAgcGFja2FnZXMgc28gdGhlIGF1dGhvcml6ZXIgY2FuXG4gICAgICAvLyBTRUxFQ1QgZnJvbSBwdWJsaWMuX2FwcF9hdXRoLlxuICAgICAgZm9yIChjb25zdCBbLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocG9saWN5RW52KSkge1xuICAgICAgICBjb25zdCBwb2xpY3kgPSBKU09OLnBhcnNlKHZhbHVlIGFzIHN0cmluZyk7XG4gICAgICAgIGZvciAoY29uc3Qgc3RhdGVtZW50IG9mIHBvbGljeS5TdGF0ZW1lbnQpIHtcbiAgICAgICAgICBmcm9udGVuZEF1dGhvcml6ZXJGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgICAgICBpYW0uUG9saWN5U3RhdGVtZW50LmZyb21Kc29uKHN0YXRlbWVudClcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEdyYW50IEFQSSBHYXRld2F5IHBlcm1pc3Npb24gdG8gaW52b2tlIHRoZSBmcm9udGVuZCBhdXRob3JpemVyXG4gICAgICBmcm9udGVuZEF1dGhvcml6ZXJGbi5hZGRQZXJtaXNzaW9uKFwiQXBpR3dBdXRob3JpemVySW52b2tlXCIsIHtcbiAgICAgICAgcHJpbmNpcGFsOiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJhcGlnYXRld2F5LmFtYXpvbmF3cy5jb21cIiksXG4gICAgICAgIHNvdXJjZUFybjogYGFybjphd3M6ZXhlY3V0ZS1hcGk6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OiR7aHR0cEFwaS5hcGlJZH0vKmAsXG4gICAgICB9KTtcblxuICAgICAgLy8gRnJvbnRlbmQgQXV0aG9yaXplciBhcyBMMSBjb25zdHJ1Y3QgKHRvIGdldCBhdXRob3JpemVyIElEKVxuICAgICAgY29uc3QgZnJvbnRlbmRBdXRob3JpemVyQ2ZuID0gbmV3IGFwaWd3djIuQ2ZuQXV0aG9yaXplcihcbiAgICAgICAgdGhpcyxcbiAgICAgICAgXCJGcm9udGVuZEF1dGhvcml6ZXJDZm5cIixcbiAgICAgICAge1xuICAgICAgICAgIGFwaUlkOiBodHRwQXBpLmFwaUlkLFxuICAgICAgICAgIGF1dGhvcml6ZXJUeXBlOiBcIlJFUVVFU1RcIixcbiAgICAgICAgICBhdXRob3JpemVyVXJpOiBgYXJuOmF3czphcGlnYXRld2F5OiR7dGhpcy5yZWdpb259OmxhbWJkYTpwYXRoLzIwMTUtMDMtMzEvZnVuY3Rpb25zLyR7ZnJvbnRlbmRBdXRob3JpemVyRm4uZnVuY3Rpb25Bcm59L2ludm9jYXRpb25zYCxcbiAgICAgICAgICBhdXRob3JpemVyUGF5bG9hZEZvcm1hdFZlcnNpb246IFwiMi4wXCIsXG4gICAgICAgICAgZW5hYmxlU2ltcGxlUmVzcG9uc2VzOiB0cnVlLFxuICAgICAgICAgIGF1dGhvcml6ZXJSZXN1bHRUdGxJblNlY29uZHM6IDAsXG4gICAgICAgICAgaWRlbnRpdHlTb3VyY2U6IFtdIGFzIHN0cmluZ1tdLCAvLyBlbXB0eSA9IGFsd2F5cyBpbnZva2UgKHN1cHBvcnRzIHB1YmxpYyBlbmRwb2ludHMpXG4gICAgICAgICAgbmFtZTogXCJGcm9udGVuZEF1dGhvcml6ZXJWMlwiLFxuICAgICAgICB9XG4gICAgICApO1xuICAgICAgZnJvbnRlbmRBdXRob3JpemVySWQgPSBmcm9udGVuZEF1dGhvcml6ZXJDZm4ucmVmO1xuXG4gICAgICAvLyBBdXRoIExhbWJkYSAobG9naW4vT1RQL3ZlcmlmeS9sb2dvdXQpLiBNdWx0aS10ZW5hbnQ6IGV4dHJhY3RzIGFwcCBmcm9tXG4gICAgICAvLyBwYXRoLCBsb29rcyB1cCBwZXItYXBwIHBvb2wgY2xpZW50ICsgUG9zdG1hcmsgdG9rZW4sIGZhbGxzIGJhY2sgdG8gdGhlXG4gICAgICAvLyBzaGFyZWQgb3JnIHBvb2wgZm9yIHVubWlncmF0ZWQgYXBwcy5cbiAgICAgIGNvbnN0IGF1dGhMYW1iZGFFbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICAgIENPR05JVE9fVVNFUl9QT09MX0lEOiBjb2duaXRvVXNlclBvb2xJZCxcbiAgICAgICAgQ09HTklUT19DTElFTlRfSUQ6IGNvZ25pdG9DbGllbnRJZCxcbiAgICAgICAgQ09HTklUT19SRUdJT046IGNvZ25pdG9SZWdpb24sXG4gICAgICAgIENVU1RPTV9ET01BSU46IGN1c3RvbURvbWFpbiA/PyBcIlwiLFxuICAgICAgICBCVUNLRVRfTkFNRTogcGxhaW5FbnZbXCJidWNrZXROYW1lXCJdID8/IFwiXCIsXG4gICAgICAgIFMzX1BSRUZJWDogcGxhaW5FbnZbXCJzM1ByZWZpeFwiXSA/PyBcIlwiLFxuICAgICAgICBPUkdBTklaQVRJT05fSUQ6IG9yZ2FuaXphdGlvbklkLFxuICAgICAgICBjbHVzdGVyQXJuOiBwbGFpbkVudltcImNsdXN0ZXJBcm5cIl0gPz8gXCJcIixcbiAgICAgICAgc2VjcmV0QXJuOiBwbGFpbkVudltcInNlY3JldEFyblwiXSA/PyBcIlwiLFxuICAgICAgICBkYXRhYmFzZU5hbWU6IHBsYWluRW52W1wiZGF0YWJhc2VOYW1lXCJdID8/IFwiXCIsXG4gICAgICB9O1xuXG4gICAgICBjb25zdCBhdXRoTGFtYmRhRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiQXV0aExhbWJkYUhhbmRsZXJcIiwge1xuICAgICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWCxcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCBcImF1dGgtbGFtYmRhXCIpKSxcbiAgICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxNSksXG4gICAgICAgIGVudmlyb25tZW50OiBhdXRoTGFtYmRhRW52LFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEdyYW50IEF1dGggTGFtYmRhIGFjY2VzcyB0byBzZWNyZXRzXG4gICAgICBjb25zdCBhdXRoU2VjcmV0S2V5czogc3RyaW5nW10gPSBbXTtcbiAgICAgIGZvciAoY29uc3QgeyBrZXksIHNlY3JldCwgc2VjcmV0TmFtZSB9IG9mIHNlY3JldEVudkVudHJpZXMpIHtcbiAgICAgICAgYXV0aExhbWJkYUZuLmFkZEVudmlyb25tZW50KGtleSwgc2VjcmV0TmFtZSk7XG4gICAgICAgIHNlY3JldC5ncmFudFJlYWQoYXV0aExhbWJkYUZuKTtcbiAgICAgICAgYXV0aFNlY3JldEtleXMucHVzaChrZXkpO1xuICAgICAgfVxuICAgICAgaWYgKGF1dGhTZWNyZXRLZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgYXV0aExhbWJkYUZuLmFkZEVudmlyb25tZW50KFwiU0VDUkVUX0tFWVNcIiwgYXV0aFNlY3JldEtleXMuam9pbihcIixcIikpO1xuICAgICAgfVxuXG4gICAgICAvLyBHcmFudCBBdXRoIExhbWJkYSBDb2duaXRvIHBlcm1pc3Npb25zICsgRGF0YSBBUEkgKHRvIHJlYWQgX2FwcF9hdXRoKS5cbiAgICAgIGZvciAoY29uc3QgWywgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHBvbGljeUVudikpIHtcbiAgICAgICAgY29uc3QgcG9saWN5ID0gSlNPTi5wYXJzZSh2YWx1ZSBhcyBzdHJpbmcpO1xuICAgICAgICBmb3IgKGNvbnN0IHN0YXRlbWVudCBvZiBwb2xpY3kuU3RhdGVtZW50KSB7XG4gICAgICAgICAgYXV0aExhbWJkYUZuLmFkZFRvUm9sZVBvbGljeShpYW0uUG9saWN5U3RhdGVtZW50LmZyb21Kc29uKHN0YXRlbWVudCkpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFJlYWQgcGVyLWFwcCBQb3N0bWFyayBzZXJ2ZXIgdG9rZW4gZnJvbSBTU00gU2VjdXJlU3RyaW5nLlxuICAgICAgY29uc3QgYXBwQXV0aFNzbUFybiA9IGBhcm46YXdzOnNzbToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06cGFyYW1ldGVyL2hlcmV5YS8ke29yZ2FuaXphdGlvbklkfS9hcHBzLypgO1xuICAgICAgYXV0aExhbWJkYUZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGFjdGlvbnM6IFtcInNzbTpHZXRQYXJhbWV0ZXJcIl0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbYXBwQXV0aFNzbUFybl0sXG4gICAgICAgIH0pXG4gICAgICApO1xuICAgICAgYXV0aExhbWJkYUZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGFjdGlvbnM6IFtcImttczpEZWNyeXB0XCJdLFxuICAgICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAgICAgXCJrbXM6VmlhU2VydmljZVwiOiBgc3NtLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb21gLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9KVxuICAgICAgKTtcblxuICAgICAgLy8gQWxsb3cgSW5pdGlhdGVBdXRoIC8gUmVzcG9uZFRvQXV0aENoYWxsZW5nZSBhZ2FpbnN0IGFueSBwZXItYXBwIHBvb2xcbiAgICAgIC8vIGluIHRoaXMgYWNjb3VudCAocG9vbCBBUk5zIGFyZSBjcmVhdGVkIGF0IHJ1bnRpbWUgYnkgZW5hYmxlLWF1dGgpLlxuICAgICAgYXV0aExhbWJkYUZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgIFwiY29nbml0by1pZHA6SW5pdGlhdGVBdXRoXCIsXG4gICAgICAgICAgICBcImNvZ25pdG8taWRwOlJlc3BvbmRUb0F1dGhDaGFsbGVuZ2VcIixcbiAgICAgICAgICBdLFxuICAgICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICAgIC8vIEdyYW50IEFQSSBHYXRld2F5IHBlcm1pc3Npb24gdG8gaW52b2tlIGF1dGggTGFtYmRhXG4gICAgICBhdXRoTGFtYmRhRm4uYWRkUGVybWlzc2lvbihcIkFwaUd3SW52b2tlXCIsIHtcbiAgICAgICAgcHJpbmNpcGFsOiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJhcGlnYXRld2F5LmFtYXpvbmF3cy5jb21cIiksXG4gICAgICAgIHNvdXJjZUFybjogYGFybjphd3M6ZXhlY3V0ZS1hcGk6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OiR7aHR0cEFwaS5hcGlJZH0vKi8qYCxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBBdXRoIExhbWJkYSBpbnRlZ3JhdGlvbiBhcyBMMSBjb25zdHJ1Y3QgKHRvIGdldCBpbnRlZ3JhdGlvbiBJRClcbiAgICAgIGNvbnN0IGF1dGhJbnRlZ3JhdGlvbkNmbiA9IG5ldyBhcGlnd3YyLkNmbkludGVncmF0aW9uKFxuICAgICAgICB0aGlzLFxuICAgICAgICBcIkF1dGhJbnRlZ3JhdGlvbkNmblwiLFxuICAgICAgICB7XG4gICAgICAgICAgYXBpSWQ6IGh0dHBBcGkuYXBpSWQsXG4gICAgICAgICAgaW50ZWdyYXRpb25UeXBlOiBcIkFXU19QUk9YWVwiLFxuICAgICAgICAgIGludGVncmF0aW9uVXJpOiBhdXRoTGFtYmRhRm4uZnVuY3Rpb25Bcm4sXG4gICAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IFwiMi4wXCIsXG4gICAgICAgIH1cbiAgICAgICk7XG4gICAgICBhdXRoSW50ZWdyYXRpb25JZCA9IGF1dGhJbnRlZ3JhdGlvbkNmbi5yZWY7XG4gICAgfVxuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBPcmcgTGFtYmRhOiBwZXItYXBwIExhbWJkYSBtYW5hZ2VtZW50IHBlcm1pc3Npb25zXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IGFwcExhbWJkYUFyblBhdHRlcm4gPSBgYXJuOmF3czpsYW1iZGE6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmZ1bmN0aW9uOiR7YXBwTGFtYmRhTmFtZVByZWZpeH0qYDtcblxuICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwibGFtYmRhOkNyZWF0ZUZ1bmN0aW9uXCIsXG4gICAgICAgICAgXCJsYW1iZGE6VXBkYXRlRnVuY3Rpb25Db2RlXCIsXG4gICAgICAgICAgXCJsYW1iZGE6VXBkYXRlRnVuY3Rpb25Db25maWd1cmF0aW9uXCIsXG4gICAgICAgICAgXCJsYW1iZGE6R2V0RnVuY3Rpb25cIixcbiAgICAgICAgICBcImxhbWJkYTpEZWxldGVGdW5jdGlvblwiLFxuICAgICAgICAgIFwibGFtYmRhOkFkZFBlcm1pc3Npb25cIixcbiAgICAgICAgICBcImxhbWJkYTpSZW1vdmVQZXJtaXNzaW9uXCIsXG4gICAgICAgICAgXCJsYW1iZGE6SW52b2tlRnVuY3Rpb25cIixcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYXBwTGFtYmRhQXJuUGF0dGVybl0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyBMYW1iZGEgbGF5ZXIgYWNjZXNzIChuZWVkZWQgd2hlbiBjcmVhdGluZyBwZXItYXBwIExhbWJkYXMgd2l0aCBsYXllcnMpXG4gICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJsYW1iZGE6R2V0TGF5ZXJWZXJzaW9uXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtydW50aW1lTGF5ZXIubGF5ZXJWZXJzaW9uQXJuXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIEFQSSBHYXRld2F5IHJvdXRlIG1hbmFnZW1lbnRcbiAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcImFwaWdhdGV3YXk6UE9TVFwiLFxuICAgICAgICAgIFwiYXBpZ2F0ZXdheTpERUxFVEVcIixcbiAgICAgICAgICBcImFwaWdhdGV3YXk6R0VUXCIsXG4gICAgICAgICAgXCJhcGlnYXRld2F5OlBBVENIXCIsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgIGBhcm46YXdzOmFwaWdhdGV3YXk6JHt0aGlzLnJlZ2lvbn06Oi9hcGlzLyR7aHR0cEFwaS5hcGlJZH0vKmAsXG4gICAgICAgIF0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyBQYXNzIHNoYXJlZCByb2xlIHRvIHBlci1hcHAgTGFtYmRhc1xuICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wiaWFtOlBhc3NSb2xlXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFthcHBMYW1iZGFSb2xlLnJvbGVBcm5dLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBTU00gU2VjdXJlU3RyaW5nIGZvciBwZXItYXBwIGFnZW50LXNlc3Npb24gc2lnbmluZyBzZWNyZXRzLlxuICAgIC8vIFByZWZpeC1ib3VuZCB0byAvaGVyZXlhL3tvcmdhbml6YXRpb25JZH0vYXBwcy8qIHNvIHRoZSBvcmcgTGFtYmRhIGFuZFxuICAgIC8vIHBlci1hcHAgTGFtYmRhcyBjYW4gb25seSB0b3VjaCB0aGVpciBvd24gb3JnJ3Mgc2VjcmV0cy5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3QgYWdlbnRTZWNyZXRTc21Bcm4gPSBgYXJuOmF3czpzc206JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnBhcmFtZXRlci9oZXJleWEvJHtvcmdhbml6YXRpb25JZH0vYXBwcy8qYDtcblxuICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwic3NtOkdldFBhcmFtZXRlclwiLFxuICAgICAgICAgIFwic3NtOkdldFBhcmFtZXRlcnNcIixcbiAgICAgICAgICBcInNzbTpQdXRQYXJhbWV0ZXJcIixcbiAgICAgICAgICBcInNzbTpEZWxldGVQYXJhbWV0ZXJcIixcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYWdlbnRTZWNyZXRTc21Bcm5dLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgYXBwTGFtYmRhUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wic3NtOkdldFBhcmFtZXRlclwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYWdlbnRTZWNyZXRTc21Bcm5dLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gS01TIGRlY3J5cHQgZm9yIHRoZSBBV1MtbWFuYWdlZCBTU00ga2V5IChTZWN1cmVTdHJpbmcpLlxuICAgIC8vIFNjb3BlZCB2aWEgVmlhU2VydmljZSBjb25kaXRpb24gc28gaXQgb25seSB3b3JrcyB0aHJvdWdoIFNTTS5cbiAgICBjb25zdCBzc21LbXNEZWNyeXB0ID0gbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogW1wia21zOkRlY3J5cHRcIl0sXG4gICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgIFwia21zOlZpYVNlcnZpY2VcIjogYHNzbS4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tYCxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgZm4uYWRkVG9Sb2xlUG9saWN5KHNzbUttc0RlY3J5cHQpO1xuICAgIGFwcExhbWJkYVJvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcImttczpEZWNyeXB0XCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAgIFwia21zOlZpYVNlcnZpY2VcIjogYHNzbS4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tYCxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gUGVyLWFwcCBMYW1iZGFzIG1heSBvcHQgaW4gdG8gcmVnaXN0ZXJpbmcgdXNlcnMgc2VydmVyLXNpZGUgdmlhIHRoZVxuICAgIC8vIGhlcmV5YSBydW50aW1lJ3MgdXNlcnMuYWRkVXNlciBoZWxwZXIuIFNpbmNlIHBlci1hcHAgQ29nbml0byBwb29scyBhcmVcbiAgICAvLyBsb2NrZWQgdG8gQWxsb3dBZG1pbkNyZWF0ZVVzZXJPbmx5PXRydWUsIHRoZSBoZWxwZXIgY2FsbHNcbiAgICAvLyBBZG1pbkNyZWF0ZVVzZXIuIFNjb3BlIGJ5IHRoZSBIZXJleWFPcmcgdGFnIG9uIHRoZSBwb29sIHNvIG9uZSBvcmcnc1xuICAgIC8vIHBlci1hcHAgTGFtYmRhcyBjYW5ub3QgY3JlYXRlIHVzZXJzIGluIGFub3RoZXIgb3JnJ3MgcG9vbHMuXG4gICAgYXBwTGFtYmRhUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wiY29nbml0by1pZHA6QWRtaW5DcmVhdGVVc2VyXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAgIFwiYXdzOlJlc291cmNlVGFnL0hlcmV5YU9yZ1wiOiBvcmdhbml6YXRpb25JZCxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBPcmcgTGFtYmRhOiBlbnZpcm9ubWVudCB2YXJpYWJsZXMgZm9yIHBlci1hcHAgTGFtYmRhIG1hbmFnZW1lbnRcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJBUFBfTEFNQkRBX1JPTEVfQVJOXCIsIGFwcExhbWJkYVJvbGUucm9sZUFybik7XG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJBUFBfTEFNQkRBX05BTUVfUFJFRklYXCIsIGFwcExhbWJkYU5hbWVQcmVmaXgpO1xuICAgIGZuLmFkZEVudmlyb25tZW50KFwiQVBQX0xBTUJEQV9MQVlFUl9BUk5cIiwgcnVudGltZUxheWVyLmxheWVyVmVyc2lvbkFybik7XG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJIVFRQX0FQSV9JRFwiLCBodHRwQXBpLmFwaUlkKTtcbiAgICBmbi5hZGRFbnZpcm9ubWVudChcIkFXU19BQ0NPVU5UX0lEXCIsIHRoaXMuYWNjb3VudCk7XG4gICAgZm4uYWRkRW52aXJvbm1lbnQoXCJPUkdBTklaQVRJT05fSURcIiwgb3JnYW5pemF0aW9uSWQpO1xuICAgIGZuLmFkZEVudmlyb25tZW50KFwiQUdFTlRfU0VDUkVUX1NTTV9QUkVGSVhcIiwgYC9oZXJleWEvJHtvcmdhbml6YXRpb25JZH0vYXBwc2ApO1xuICAgIGZuLmFkZEVudmlyb25tZW50KFwiQ09HTklUT19UUklHR0VSX0xBTUJEQV9BUk5TXCIsIHRyaWdnZXJBcm5zLmpvaW4oXCIsXCIpKTtcbiAgICBmbi5hZGRFbnZpcm9ubWVudChcImF3c1JlZ2lvblwiLCB0aGlzLnJlZ2lvbik7XG5cbiAgICBpZiAoZnJvbnRlbmRBdXRob3JpemVySWQpIHtcbiAgICAgIGZuLmFkZEVudmlyb25tZW50KFwiRlJPTlRFTkRfQVVUSE9SSVpFUl9JRFwiLCBmcm9udGVuZEF1dGhvcml6ZXJJZCk7XG4gICAgfVxuICAgIGlmIChhdXRoSW50ZWdyYXRpb25JZCkge1xuICAgICAgZm4uYWRkRW52aXJvbm1lbnQoXCJBVVRIX0lOVEVHUkFUSU9OX0lEXCIsIGF1dGhJbnRlZ3JhdGlvbklkKTtcbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIE9yZyBMYW1iZGE6IHBlci1hcHAgYXV0aCBwcm92aXNpb25pbmcgcGVybWlzc2lvbnMgKGVuYWJsZS1hdXRoIHRvb2wpLlxuICAgIC8vXG4gICAgLy8gUGVyLWFwcCBDb2duaXRvIHBvb2xzICsgY2xpZW50cyBhcmUgY3JlYXRlZCBhdCBydW50aW1lIChyZXNvdXJjZXMgYXJlXG4gICAgLy8gb25seSBrbm93biBhZnRlciBDcmVhdGVVc2VyUG9vbCBzdWNjZWVkcyksIHNvIHJlc291cmNlPVwiKlwiLiBUaGUgb3JnXG4gICAgLy8gTGFtYmRhIG5lZWRzIHRvIGF0dGFjaCB0aGUgc2hhcmVkIHRyaWdnZXIgTGFtYmRhcyB0byBlYWNoIG5ldyBwb29sXG4gICAgLy8gKEFkZFBlcm1pc3Npb24pIGFuZCBjbGVhbiB0aGVtIHVwIG9uIGRyb3Atc2NoZW1hIChSZW1vdmVQZXJtaXNzaW9uKS5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpDcmVhdGVVc2VyUG9vbFwiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6RGVsZXRlVXNlclBvb2xcIixcbiAgICAgICAgICBcImNvZ25pdG8taWRwOlVwZGF0ZVVzZXJQb29sXCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpEZXNjcmliZVVzZXJQb29sXCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpMaXN0VXNlclBvb2xzXCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpDcmVhdGVVc2VyUG9vbENsaWVudFwiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6RGVsZXRlVXNlclBvb2xDbGllbnRcIixcbiAgICAgICAgICBcImNvZ25pdG8taWRwOlVwZGF0ZVVzZXJQb29sQ2xpZW50XCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpEZXNjcmliZVVzZXJQb29sQ2xpZW50XCIsXG4gICAgICAgICAgXCJjb2duaXRvLWlkcDpBZG1pbkNyZWF0ZVVzZXJcIixcbiAgICAgICAgICBcImNvZ25pdG8taWRwOkxpc3RVc2Vyc1wiLFxuICAgICAgICAgIFwiY29nbml0by1pZHA6VGFnUmVzb3VyY2VcIixcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgZm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJsYW1iZGE6QWRkUGVybWlzc2lvblwiLCBcImxhbWJkYTpSZW1vdmVQZXJtaXNzaW9uXCJdLFxuICAgICAgICByZXNvdXJjZXM6IHRyaWdnZXJBcm5zLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBDdXN0b20gZG9tYWluICsgRE5TXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGlmIChjdXN0b21Eb21haW4gJiYgY3VzdG9tRG9tYWluWm9uZSkge1xuICAgICAgaWYgKCF3aWxkY2FyZENlcnRpZmljYXRlQXJuKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIndpbGRjYXJkQ2VydGlmaWNhdGVBcm4gaXMgcmVxdWlyZWQgd2hlbiBjdXN0b21Eb21haW4gaXMgc2V0XCJcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgY2VydGlmaWNhdGUgPSBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKFxuICAgICAgICB0aGlzLFxuICAgICAgICBcIkNlcnRpZmljYXRlXCIsXG4gICAgICAgIHdpbGRjYXJkQ2VydGlmaWNhdGVBcm5cbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IGhvc3RlZFpvbmUgPSByb3V0ZTUzLkhvc3RlZFpvbmUuZnJvbUxvb2t1cCh0aGlzLCBcIkhvc3RlZFpvbmVcIiwge1xuICAgICAgICBkb21haW5OYW1lOiBjdXN0b21Eb21haW5ab25lLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEV4cG9zZSBob3N0ZWQgem9uZSBJRCArIGdyYW50IFJvdXRlNTMgcmVjb3JkLXNldCBtYW5hZ2VtZW50IHNvIHRoZVxuICAgICAgLy8gb3JnIExhbWJkYSBjYW4gd3JpdGUgREtJTSArIHJldHVybi1wYXRoIHJlY29yZHMgd2hlbiBwcm92aXNpb25pbmdcbiAgICAgIC8vIHBlci1hcHAgUG9zdG1hcmsgZG9tYWlucyB2aWEgZW5hYmxlLWF1dGguXG4gICAgICBmbi5hZGRFbnZpcm9ubWVudChcIkhPU1RFRF9aT05FX0lEXCIsIGhvc3RlZFpvbmUuaG9zdGVkWm9uZUlkKTtcbiAgICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgIFwicm91dGU1MzpDaGFuZ2VSZXNvdXJjZVJlY29yZFNldHNcIixcbiAgICAgICAgICAgIFwicm91dGU1MzpMaXN0UmVzb3VyY2VSZWNvcmRTZXRzXCIsXG4gICAgICAgICAgICBcInJvdXRlNTM6R2V0SG9zdGVkWm9uZVwiLFxuICAgICAgICAgIF0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgICBgYXJuOmF3czpyb3V0ZTUzOjo6aG9zdGVkem9uZS8ke2hvc3RlZFpvbmUuaG9zdGVkWm9uZUlkfWAsXG4gICAgICAgICAgXSxcbiAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICAgIC8vIEFQSSBHYXRld2F5IGN1c3RvbSBkb21haW4gZm9yIE1DUCAoZXhhY3QgZG9tYWluKVxuICAgICAgY29uc3QgZG9tYWluTmFtZSA9IG5ldyBhcGlnd3YyLkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgICAgZG9tYWluTmFtZTogY3VzdG9tRG9tYWluLFxuICAgICAgICBjZXJ0aWZpY2F0ZSxcbiAgICAgIH0pO1xuXG4gICAgICBuZXcgYXBpZ3d2Mi5BcGlNYXBwaW5nKHRoaXMsIFwiQXBpTWFwcGluZ1wiLCB7XG4gICAgICAgIGFwaTogaHR0cEFwaSxcbiAgICAgICAgZG9tYWluTmFtZSxcbiAgICAgIH0pO1xuXG4gICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiBjdXN0b21Eb21haW4sXG4gICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKFxuICAgICAgICAgIG5ldyB0YXJnZXRzLkFwaUdhdGV3YXl2MkRvbWFpblByb3BlcnRpZXMoXG4gICAgICAgICAgICBkb21haW5OYW1lLnJlZ2lvbmFsRG9tYWluTmFtZSxcbiAgICAgICAgICAgIGRvbWFpbk5hbWUucmVnaW9uYWxIb3N0ZWRab25lSWRcbiAgICAgICAgICApXG4gICAgICAgICksXG4gICAgICB9KTtcblxuICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgLy8gQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gZm9yIGZyb250ZW5kICgqLntjdXN0b21Eb21haW59KVxuICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgICBpZiAoY29nbml0b1VzZXJQb29sSWQgJiYgY29nbml0b0NsaWVudElkKSB7XG4gICAgICAgIGNvbnN0IGNsb3VkZnJvbnRDZXJ0aWZpY2F0ZSA9IG5ldyBhY20uRG5zVmFsaWRhdGVkQ2VydGlmaWNhdGUoXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICBcIkNsb3VkRnJvbnRDZXJ0aWZpY2F0ZVwiLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGRvbWFpbk5hbWU6IGAqLiR7Y3VzdG9tRG9tYWlufWAsXG4gICAgICAgICAgICBob3N0ZWRab25lLFxuICAgICAgICAgICAgcmVnaW9uOiBcInVzLWVhc3QtMVwiLFxuICAgICAgICAgIH1cbiAgICAgICAgKTtcblxuICAgICAgICAvLyBDbG91ZEZyb250IEZ1bmN0aW9uOiBleHRyYWN0IGFwcCBzdWJkb21haW4g4oaSIHByZXBlbmQgdG8gcGF0aCwgYW5kXG4gICAgICAgIC8vICh3aGVuIHRoZSBvcmcgTGFtYmRhIHJlZ2VuZXJhdGVzIHRoZSBjb2RlKSByb3V0ZSBjdXN0b20gdmFuaXR5XG4gICAgICAgIC8vIGRvbWFpbnMgdmlhIGEgcGVyLWhvc3QgZG9tYWluTWFwIGxvb2t1cC5cbiAgICAgICAgLy9cbiAgICAgICAgLy8gVGhpcyBpbmxpbmUgY29kZSBpcyB0aGUgQk9PVFNUUkFQIHZlcnNpb24gd2l0aCBhbiBlbXB0eSBkb21haW5NYXAuXG4gICAgICAgIC8vIE9uIHRoZSBmaXJzdCBgc2V0LWN1c3RvbS1kb21haW5zYC9gY2hlY2stY3VzdG9tLWRvbWFpbnNgIGN5Y2xlIHRoZVxuICAgICAgICAvLyBvcmcgTGFtYmRhIG92ZXJ3cml0ZXMgdGhpcyBmdW5jdGlvbiB3aXRoIGEgcmVnZW5lcmF0ZWQgdmVyc2lvbiB0aGF0XG4gICAgICAgIC8vIGNvbnRhaW5zIHRoZSBhY3RpdmUgZG9tYWlu4oaSc2NoZW1hIG1hcHBpbmcuIFRoZSBzaGFwZSBtdXN0IG1hdGNoXG4gICAgICAgIC8vIHNyYy9jdXN0b20tZG9tYWluLXRlbXBsYXRlLnRzIGluIHRoZSBoZXJleWEtYXBwcyByZXBvIHNvIHJ1bnRpbWVcbiAgICAgICAgLy8gdXBkYXRlcyBhcmUgZHJvcC1pbiByZXBsYWNlbWVudHMuXG4gICAgICAgIGNvbnN0IGNmRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlN1YmRvbWFpblJld3JpdGVcIiwge1xuICAgICAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21JbmxpbmUoYFxuZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuICB2YXIgcmVxdWVzdCA9IGV2ZW50LnJlcXVlc3Q7XG4gIHZhciBob3N0ID0gcmVxdWVzdC5oZWFkZXJzLmhvc3QudmFsdWU7XG4gIHZhciBjdXN0b21Eb21haW4gPSAke0pTT04uc3RyaW5naWZ5KGN1c3RvbURvbWFpbil9O1xuICB2YXIgZG9tYWluTWFwID0ge307XG4gIGlmIChkb21haW5NYXBbaG9zdF0pIHtcbiAgICByZXF1ZXN0LnVyaSA9ICcvJyArIGRvbWFpbk1hcFtob3N0XSArIHJlcXVlc3QudXJpO1xuICAgIHJldHVybiByZXF1ZXN0O1xuICB9XG4gIGlmIChob3N0ICE9PSBjdXN0b21Eb21haW4gJiYgaG9zdC5lbmRzV2l0aCgnLicgKyBjdXN0b21Eb21haW4pKSB7XG4gICAgdmFyIGFwcE5hbWUgPSBob3N0LnNsaWNlKDAsIC0oY3VzdG9tRG9tYWluLmxlbmd0aCArIDEpKTtcbiAgICByZXF1ZXN0LnVyaSA9ICcvJyArIGFwcE5hbWUgKyByZXF1ZXN0LnVyaTtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cbiAgICAgICAgICBgKSxcbiAgICAgICAgICBmdW5jdGlvbk5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1zdWJkb21haW4tcmV3cml0ZWAsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEFQSSBHYXRld2F5IG9yaWdpblxuICAgICAgICBjb25zdCBhcGlEb21haW5OYW1lID0gY2RrLkZuLnNlbGVjdChcbiAgICAgICAgICAyLFxuICAgICAgICAgIGNkay5Gbi5zcGxpdChcIi9cIiwgaHR0cEFwaS5hcGlFbmRwb2ludClcbiAgICAgICAgKTtcblxuICAgICAgICBjb25zdCBkaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24oXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICBcIkZyb250ZW5kRGlzdHJpYnV0aW9uXCIsXG4gICAgICAgICAge1xuICAgICAgICAgICAgY2VydGlmaWNhdGU6IGNsb3VkZnJvbnRDZXJ0aWZpY2F0ZSxcbiAgICAgICAgICAgIGRvbWFpbk5hbWVzOiBbYCouJHtjdXN0b21Eb21haW59YF0sXG4gICAgICAgICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgICAgICAgb3JpZ2luOiBuZXcgb3JpZ2lucy5IdHRwT3JpZ2luKGFwaURvbWFpbk5hbWUsIHtcbiAgICAgICAgICAgICAgICBwcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5PcmlnaW5Qcm90b2NvbFBvbGljeS5IVFRQU19PTkxZLFxuICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6XG4gICAgICAgICAgICAgICAgY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICAgICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBuZXcgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UG9saWN5KFxuICAgICAgICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgICAgICAgXCJGcm9udGVuZE9yaWdpblBvbGljeVwiLFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgIGNvb2tpZUJlaGF2aW9yOlxuICAgICAgICAgICAgICAgICAgICBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5hbGxvd0xpc3QoXG4gICAgICAgICAgICAgICAgICAgICAgXCJoZXJleWFfaWRfdG9rZW5cIixcbiAgICAgICAgICAgICAgICAgICAgICBcImhlcmV5YV9hZ2VudFwiXG4gICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICBoZWFkZXJCZWhhdmlvcjpcbiAgICAgICAgICAgICAgICAgICAgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0SGVhZGVyQmVoYXZpb3IuYWxsb3dMaXN0KFxuICAgICAgICAgICAgICAgICAgICAgIFwiQ29udGVudC1UeXBlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgXCJBY2NlcHQtTGFuZ3VhZ2VcIixcbiAgICAgICAgICAgICAgICAgICAgICAvLyBUaGUgc3ViZG9tYWluLXJld3JpdGUgdmlld2VyLXJlcXVlc3QgQ0YgZnVuY3Rpb24gY29waWVzXG4gICAgICAgICAgICAgICAgICAgICAgLy8gdGhlIHZpZXdlciBIb3N0IGludG8geC1mb3J3YXJkZWQtaG9zdCBzbyB0aGUgYXV0aCBMYW1iZGFcbiAgICAgICAgICAgICAgICAgICAgICAvLyBjYW4gc2NvcGUgdGhlIHNlc3Npb24gY29va2llJ3MgRG9tYWluIGF0dHJpYnV0ZSB0byB0aGVcbiAgICAgICAgICAgICAgICAgICAgICAvLyBob3N0IHRoZSB1c2VyIGFjdHVhbGx5IHR5cGVkIChpbmNsdWRpbmcgY3VzdG9tIHZhbml0eVxuICAgICAgICAgICAgICAgICAgICAgIC8vIGRvbWFpbnMpLiBDbG91ZEZyb250IHN0cmlwcyBoZWFkZXJzIGFkZGVkIGJ5IHZpZXdlci1cbiAgICAgICAgICAgICAgICAgICAgICAvLyByZXF1ZXN0IGZ1bmN0aW9ucyBiZWZvcmUgZm9yd2FyZGluZyB0byBvcmlnaW4gdW5sZXNzXG4gICAgICAgICAgICAgICAgICAgICAgLy8gdGhleSdyZSBleHBsaWNpdGx5IHdoaXRlbGlzdGVkIGhlcmUg4oCUIHdpdGhvdXQgdGhpc1xuICAgICAgICAgICAgICAgICAgICAgIC8vIGVudHJ5LCB2YW5pdHktaG9zdCBsb2dpbnMgc2V0IGEgY29va2llIHNjb3BlZCB0byB0aGVcbiAgICAgICAgICAgICAgICAgICAgICAvLyBkZWZhdWx0IGN1c3RvbURvbWFpbiBhbmQgdGhlIGJyb3dzZXIgc2lsZW50bHkgcmVqZWN0c1xuICAgICAgICAgICAgICAgICAgICAgIC8vIGl0IChSRkMgNjI2NSBkb21haW4gbWlzbWF0Y2gpLCBicmVha2luZyBsb2dpbi5cbiAgICAgICAgICAgICAgICAgICAgICBcIngtZm9yd2FyZGVkLWhvc3RcIixcbiAgICAgICAgICAgICAgICAgICAgICAvLyBJbmJvdW5kIHdlYmhvb2sgcHJvdmlkZXJzIGNhcnJ5IGEgc2hhcmVkIHNlY3JldCBpbiBhXG4gICAgICAgICAgICAgICAgICAgICAgLy8gY3VzdG9tIGhlYWRlciB0aGF0IHRoZSBwZXItYXBwIHdlYmhvb2sgaGFuZGxlciB2ZXJpZmllcy5cbiAgICAgICAgICAgICAgICAgICAgICAvLyBDbG91ZEZyb250IHdoaXRlbGlzdHMgaGVhZGVycyBmb3J3YXJkZWQgdG8gb3JpZ2luLCBzb1xuICAgICAgICAgICAgICAgICAgICAgIC8vIHRoZXNlIG11c3QgYmUgbGlzdGVkIG9yIHRoZXkncmUgc3RyaXBwZWQgKGNhdXNpbmcgdGhlXG4gICAgICAgICAgICAgICAgICAgICAgLy8gaGFuZGxlciB0byA0MDEgZXZlcnkgZGVsaXZlcnkpLiBUZWxlZ3JhbSB1c2VzXG4gICAgICAgICAgICAgICAgICAgICAgLy8gWC1UZWxlZ3JhbS1Cb3QtQXBpLVNlY3JldC1Ub2tlbi5cbiAgICAgICAgICAgICAgICAgICAgICBcIlgtVGVsZWdyYW0tQm90LUFwaS1TZWNyZXQtVG9rZW5cIlxuICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjpcbiAgICAgICAgICAgICAgICAgICAgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgZnVuY3Rpb246IGNmRnVuY3Rpb24sXG4gICAgICAgICAgICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25FdmVudFR5cGUuVklFV0VSX1JFUVVFU1QsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIFJvdXRlNTMgd2lsZGNhcmQgLT4gQ2xvdWRGcm9udFxuICAgICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiV2lsZGNhcmRBbGlhc1JlY29yZFwiLCB7XG4gICAgICAgICAgem9uZTogaG9zdGVkWm9uZSxcbiAgICAgICAgICByZWNvcmROYW1lOiBgKi4ke2N1c3RvbURvbWFpbn1gLFxuICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKFxuICAgICAgICAgICAgbmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldChkaXN0cmlidXRpb24pXG4gICAgICAgICAgKSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJGcm9udGVuZERpc3RyaWJ1dGlvbkRvbWFpblwiLCB7XG4gICAgICAgICAgdmFsdWU6IGRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Eb21haW5OYW1lLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgICAvLyBDdXN0b20tZG9tYWluIHN1cHBvcnQgd2lyaW5nXG4gICAgICAgIC8vXG4gICAgICAgIC8vIFRoZSBvcmcgTGFtYmRhIGV4cG9zZXMgTUNQIHRvb2xzIHRoYXQgc3dhcCB0aGUgZGlzdHJpYnV0aW9uJ3NcbiAgICAgICAgLy8gVmlld2VyQ2VydGlmaWNhdGUgaW4tcGxhY2Ugd2hlbiB1c2VycyByZXF1ZXN0IHZhbml0eSBkb21haW5zLiBXZTpcbiAgICAgICAgLy8gICAxLiBTZWVkIGFuIFNTTSBwYXJhbSB3aXRoIHRoZSBib290c3RyYXAgd2lsZGNhcmQgY2VydCBBUk4gb25cbiAgICAgICAgLy8gICAgICBmaXJzdCBkZXBsb3kgKG9uVXBkYXRlIGlzIGEgbm8tb3Ag4oaSIHN1YnNlcXVlbnQgZGVwbG95cyBkb24ndFxuICAgICAgICAvLyAgICAgIG92ZXJ3cml0ZSB0aGUgTGFtYmRhJ3MgbGl2ZSBjZXJ0IEFSTikuXG4gICAgICAgIC8vICAgMi4gR3JhbnQgdGhlIG9yZyBMYW1iZGEgQUNNICh0YWctc2NvcGVkKSArIENsb3VkRnJvbnQgKEFSTi1zY29wZWQpXG4gICAgICAgIC8vICAgICAgKyBTU00gKHBhdGgtc2NvcGVkKSBwZXJtaXNzaW9ucy5cbiAgICAgICAgLy8gICAzLiBQYXNzIGRpc3RyaWJ1dGlvbiArIGZ1bmN0aW9uIGlkZW50aWZpZXJzICsgU1NNIHBhdGggdGhyb3VnaCBlbnYuXG4gICAgICAgIC8vXG4gICAgICAgIC8vIE5PVEUgb24gZHJpZnQ6IGlmIGEgZnV0dXJlIENESyBzdGFjayBjaGFuZ2UgdG91Y2hlcyB0aGUgRGlzdHJpYnV0aW9uXG4gICAgICAgIC8vIG9yIHRoZSBDRiBmdW5jdGlvbiwgQ2xvdWRGb3JtYXRpb24gd2lsbCByZS1zZW5kIENESydzIGlubGluZSBjb25maWdcbiAgICAgICAgLy8gYW5kIG92ZXJ3cml0ZSB0aGUgTGFtYmRhJ3MgbGl2ZSBzdGF0ZS4gUmVtZWRpYXRpb24gaXMgdG8gcmUtcnVuXG4gICAgICAgIC8vIGBjaGVjay1jdXN0b20tZG9tYWluc2AgYWZ0ZXIgdGhlIHN0YWNrIHVwZGF0ZS5cbiAgICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgICAgICBjb25zdCB2aWV3ZXJDZXJ0U3NtUGFyYW1OYW1lID0gYC9oZXJleWEvJHtvcmdhbml6YXRpb25JZH0vdmlld2VyLWNlcnQtYXJuYDtcbiAgICAgICAgY29uc3Qgdmlld2VyQ2VydFNzbVBhcmFtQXJuID0gYGFybjphd3M6c3NtOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpwYXJhbWV0ZXIke3ZpZXdlckNlcnRTc21QYXJhbU5hbWV9YDtcblxuICAgICAgICBjb25zdCBzZWVkVmlld2VyQ2VydEFybiA9IG5ldyBjci5Bd3NDdXN0b21SZXNvdXJjZShcbiAgICAgICAgICB0aGlzLFxuICAgICAgICAgIFwiVmlld2VyQ2VydFNzbVNlZWRcIixcbiAgICAgICAgICB7XG4gICAgICAgICAgICBvbkNyZWF0ZToge1xuICAgICAgICAgICAgICBzZXJ2aWNlOiBcIlNTTVwiLFxuICAgICAgICAgICAgICBhY3Rpb246IFwiUHV0UGFyYW1ldGVyXCIsXG4gICAgICAgICAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgICAgICBOYW1lOiB2aWV3ZXJDZXJ0U3NtUGFyYW1OYW1lLFxuICAgICAgICAgICAgICAgIFZhbHVlOiBjbG91ZGZyb250Q2VydGlmaWNhdGUuY2VydGlmaWNhdGVBcm4sXG4gICAgICAgICAgICAgICAgVHlwZTogXCJTdHJpbmdcIixcbiAgICAgICAgICAgICAgICBPdmVyd3JpdGU6IGZhbHNlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBwaHlzaWNhbFJlc291cmNlSWQ6IGNyLlBoeXNpY2FsUmVzb3VyY2VJZC5vZihcbiAgICAgICAgICAgICAgICBgdmlld2VyLWNlcnQtc2VlZC0ke29yZ2FuaXphdGlvbklkfWBcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgaWdub3JlRXJyb3JDb2Rlc01hdGNoaW5nOiBcIlBhcmFtZXRlckFscmVhZHlFeGlzdHNcIixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBvblVwZGF0ZToge1xuICAgICAgICAgICAgICBzZXJ2aWNlOiBcIlNTTVwiLFxuICAgICAgICAgICAgICBhY3Rpb246IFwiR2V0UGFyYW1ldGVyXCIsXG4gICAgICAgICAgICAgIHBhcmFtZXRlcnM6IHsgTmFtZTogdmlld2VyQ2VydFNzbVBhcmFtTmFtZSB9LFxuICAgICAgICAgICAgICBwaHlzaWNhbFJlc291cmNlSWQ6IGNyLlBoeXNpY2FsUmVzb3VyY2VJZC5vZihcbiAgICAgICAgICAgICAgICBgdmlld2VyLWNlcnQtc2VlZC0ke29yZ2FuaXphdGlvbklkfWBcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgaWdub3JlRXJyb3JDb2Rlc01hdGNoaW5nOiBcIlBhcmFtZXRlck5vdEZvdW5kXCIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgb25EZWxldGU6IHtcbiAgICAgICAgICAgICAgc2VydmljZTogXCJTU01cIixcbiAgICAgICAgICAgICAgYWN0aW9uOiBcIkRlbGV0ZVBhcmFtZXRlclwiLFxuICAgICAgICAgICAgICBwYXJhbWV0ZXJzOiB7IE5hbWU6IHZpZXdlckNlcnRTc21QYXJhbU5hbWUgfSxcbiAgICAgICAgICAgICAgaWdub3JlRXJyb3JDb2Rlc01hdGNoaW5nOiBcIlBhcmFtZXRlck5vdEZvdW5kXCIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgcG9saWN5OiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5mcm9tU3RhdGVtZW50cyhbXG4gICAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgICBcInNzbTpQdXRQYXJhbWV0ZXJcIixcbiAgICAgICAgICAgICAgICAgIFwic3NtOkdldFBhcmFtZXRlclwiLFxuICAgICAgICAgICAgICAgICAgXCJzc206RGVsZXRlUGFyYW1ldGVyXCIsXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICByZXNvdXJjZXM6IFt2aWV3ZXJDZXJ0U3NtUGFyYW1Bcm5dLFxuICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgaW5zdGFsbExhdGVzdEF3c1NkazogZmFsc2UsXG4gICAgICAgICAgfVxuICAgICAgICApO1xuICAgICAgICBzZWVkVmlld2VyQ2VydEFybi5ub2RlLmFkZERlcGVuZGVuY3koY2xvdWRmcm9udENlcnRpZmljYXRlKTtcblxuICAgICAgICAvLyAtLS0gQUNNICh0YWctc2NvcGVkKTogYW55IGNlcnQgdGhlIG9yZyBMYW1iZGEgY3JlYXRlcyBtdXN0IGJlXG4gICAgICAgIC8vICAgICB0YWdnZWQgd2l0aCBpdHMgb3duIG9yZ0lkOyBhbGwgbm9uLWNyZWF0ZSBhY3Rpb25zIGFyZSBnYXRlZCBvblxuICAgICAgICAvLyAgICAgdGhlIHNhbWUgdGFnIG1hdGNoaW5nIG9uIHRoZSByZXNvdXJjZS4gVGhpcyBwcmV2ZW50cyBvcmcgQSBmcm9tXG4gICAgICAgIC8vICAgICB0b3VjaGluZyBvcmcgQidzIGNlcnRzLlxuICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICBcImFjbTpSZXF1ZXN0Q2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgICAgXCJhY206QWRkVGFnc1RvQ2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICAgICAgIFwiYXdzOlJlcXVlc3RUYWcvaGVyZXlhOm9yZ0lkXCI6IG9yZ2FuaXphdGlvbklkLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBcIkZvckFsbFZhbHVlczpTdHJpbmdFcXVhbHNcIjoge1xuICAgICAgICAgICAgICAgIFwiYXdzOlRhZ0tleXNcIjogW1xuICAgICAgICAgICAgICAgICAgXCJoZXJleWE6b3JnSWRcIixcbiAgICAgICAgICAgICAgICAgIFwiaGVyZXlhOnNjaGVtYVwiLFxuICAgICAgICAgICAgICAgICAgXCJoZXJleWE6ZG9tYWluc1wiLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pXG4gICAgICAgICk7XG4gICAgICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgIFwiYWNtOkRlc2NyaWJlQ2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgICAgXCJhY206RGVsZXRlQ2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgICAgXCJhY206TGlzdFRhZ3NGb3JDZXJ0aWZpY2F0ZVwiLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgICAgICBgYXJuOmF3czphY206dXMtZWFzdC0xOiR7dGhpcy5hY2NvdW50fTpjZXJ0aWZpY2F0ZS8qYCxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICAgICAgIFwiYXdzOlJlc291cmNlVGFnL2hlcmV5YTpvcmdJZFwiOiBvcmdhbml6YXRpb25JZCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSlcbiAgICAgICAgKTtcblxuICAgICAgICAvLyAtLS0gQ2xvdWRGcm9udCAoQVJOLXNjb3BlZCk6IHRoZSBvcmcgTGFtYmRhIG1heSBvbmx5IHVwZGF0ZSBJVFNcbiAgICAgICAgLy8gICAgIG93biBkaXN0cmlidXRpb24gYW5kIGZ1bmN0aW9uLlxuICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICBcImNsb3VkZnJvbnQ6R2V0RGlzdHJpYnV0aW9uXCIsXG4gICAgICAgICAgICAgIFwiY2xvdWRmcm9udDpHZXREaXN0cmlidXRpb25Db25maWdcIixcbiAgICAgICAgICAgICAgXCJjbG91ZGZyb250OlVwZGF0ZURpc3RyaWJ1dGlvblwiLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgICAgICBgYXJuOmF3czpjbG91ZGZyb250Ojoke3RoaXMuYWNjb3VudH06ZGlzdHJpYnV0aW9uLyR7ZGlzdHJpYnV0aW9uLmRpc3RyaWJ1dGlvbklkfWAsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH0pXG4gICAgICAgICk7XG4gICAgICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgIFwiY2xvdWRmcm9udDpHZXRGdW5jdGlvblwiLFxuICAgICAgICAgICAgICBcImNsb3VkZnJvbnQ6RGVzY3JpYmVGdW5jdGlvblwiLFxuICAgICAgICAgICAgICBcImNsb3VkZnJvbnQ6VXBkYXRlRnVuY3Rpb25cIixcbiAgICAgICAgICAgICAgXCJjbG91ZGZyb250OlB1Ymxpc2hGdW5jdGlvblwiLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgICAgICBgYXJuOmF3czpjbG91ZGZyb250Ojoke3RoaXMuYWNjb3VudH06ZnVuY3Rpb24vJHtjZkZ1bmN0aW9uLmZ1bmN0aW9uTmFtZX1gLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9KVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIC0tLSBTU00gKHBhdGgtc2NvcGVkKTogd3JpdGUgdGhlIGNlcnQgQVJOIG9uIHN3YXAuXG4gICAgICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICBhY3Rpb25zOiBbXCJzc206R2V0UGFyYW1ldGVyXCIsIFwic3NtOlB1dFBhcmFtZXRlclwiXSxcbiAgICAgICAgICAgIHJlc291cmNlczogW3ZpZXdlckNlcnRTc21QYXJhbUFybl0sXG4gICAgICAgICAgfSlcbiAgICAgICAgKTtcblxuICAgICAgICAvLyAtLS0gRXhwb3NlIElEcyB0byB0aGUgb3JnIExhbWJkYS5cbiAgICAgICAgZm4uYWRkRW52aXJvbm1lbnQoXG4gICAgICAgICAgXCJDTE9VREZST05UX0RJU1RSSUJVVElPTl9JRFwiLFxuICAgICAgICAgIGRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25JZFxuICAgICAgICApO1xuICAgICAgICBmbi5hZGRFbnZpcm9ubWVudChcIkNMT1VERlJPTlRfRlVOQ1RJT05fTkFNRVwiLCBjZkZ1bmN0aW9uLmZ1bmN0aW9uTmFtZSk7XG4gICAgICAgIGZuLmFkZEVudmlyb25tZW50KFxuICAgICAgICAgIFwiQ0xPVURGUk9OVF9ET01BSU5cIixcbiAgICAgICAgICBkaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uRG9tYWluTmFtZVxuICAgICAgICApO1xuICAgICAgICBmbi5hZGRFbnZpcm9ubWVudChcIlZJRVdFUl9DRVJUX1NTTV9QQVJBTVwiLCB2aWV3ZXJDZXJ0U3NtUGFyYW1OYW1lKTtcbiAgICAgICAgZm4ubm9kZS5hZGREZXBlbmRlbmN5KHNlZWRWaWV3ZXJDZXJ0QXJuKTtcbiAgICAgIH1cblxuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJTZXJ2aWNlVXJsXCIsIHtcbiAgICAgICAgdmFsdWU6IGBodHRwczovLyR7Y3VzdG9tRG9tYWlufWAsXG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJTZXJ2aWNlVXJsXCIsIHtcbiAgICAgICAgdmFsdWU6IGh0dHBBcGkuYXBpRW5kcG9pbnQsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gZXh0cmFjdERvbWFpblpvbmUoXG4gIGN1c3RvbURvbWFpbjogc3RyaW5nIHwgdW5kZWZpbmVkXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAoIWN1c3RvbURvbWFpbikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgcGFydHMgPSBjdXN0b21Eb21haW4uc3BsaXQoXCIuXCIpO1xuICBpZiAocGFydHMubGVuZ3RoIDwgMikgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBkb21haW4gbmFtZTogXCIgKyBjdXN0b21Eb21haW4pO1xuICByZXR1cm4gcGFydHMubGVuZ3RoID09PSAyID8gY3VzdG9tRG9tYWluIDogcGFydHMuc2xpY2UoMSkuam9pbihcIi5cIik7XG59XG4iXX0=