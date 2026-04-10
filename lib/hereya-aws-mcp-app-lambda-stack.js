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
        // Lambda 1: App Handler (Org Lambda — MCP + frontend routes)
        // -----------------------------------------------------------------------
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
        // -----------------------------------------------------------------------
        // Frontend Authorizer Lambda (Cognito JWT cookie validation)
        // -----------------------------------------------------------------------
        let frontendAuthorizer;
        if (cognitoUserPoolId && cognitoClientId) {
            const frontendAuthorizerFn = new lambda.Function(this, "FrontendAuthorizerHandler", {
                runtime: lambda.Runtime.NODEJS_22_X,
                handler: "index.handler",
                code: lambda.Code.fromAsset(path.join(__dirname, "frontend-authorizer")),
                memorySize: 128,
                timeout: cdk.Duration.seconds(10),
                environment: {
                    COGNITO_USER_POOL_ID: cognitoUserPoolId,
                    COGNITO_REGION: cognitoRegion,
                },
            });
            frontendAuthorizer = new authorizers.HttpLambdaAuthorizer("FrontendAuthorizer", frontendAuthorizerFn, {
                responseTypes: [authorizers.HttpLambdaResponseType.SIMPLE],
                resultsCacheTtl: cdk.Duration.seconds(0), // No caching — cookie-based
                identitySource: ["$request.header.Cookie"],
            });
            // -------------------------------------------------------------------
            // Auth Lambda (login/OTP/verify/logout)
            // -------------------------------------------------------------------
            const authLambdaEnv = {
                COGNITO_USER_POOL_ID: cognitoUserPoolId,
                COGNITO_CLIENT_ID: cognitoClientId,
                COGNITO_REGION: cognitoRegion,
                CUSTOM_DOMAIN: customDomain ?? "",
            };
            const authLambdaFn = new lambda.Function(this, "AuthLambdaHandler", {
                runtime: lambda.Runtime.NODEJS_22_X,
                handler: "index.handler",
                code: lambda.Code.fromAsset(path.join(__dirname, "auth-lambda")),
                memorySize: 128,
                timeout: cdk.Duration.seconds(15),
                environment: authLambdaEnv,
            });
            // Grant Auth Lambda access to all secrets from hereyaProjectEnv
            // (same secrets already created for the main handler — reuse them)
            const authSecretKeys = [];
            for (const { key, secret, secretName } of secretEnvEntries) {
                authLambdaFn.addEnvironment(key, secretName);
                secret.grantRead(authLambdaFn);
                authSecretKeys.push(key);
            }
            if (authSecretKeys.length > 0) {
                authLambdaFn.addEnvironment("SECRET_KEYS", authSecretKeys.join(","));
            }
            const authLambdaIntegration = new integrations.HttpLambdaIntegration("AuthLambdaIntegration", authLambdaFn);
            // Auth routes (no authorizer — always accessible)
            httpApi.addRoutes({
                path: "/{app}/auth/{proxy+}",
                methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
                integration: authLambdaIntegration,
            });
            // Frontend routes (with Frontend Authorizer → Org Lambda)
            const frontendRoutePatterns = [
                "/{app}/view/{proxy+}",
                "/{app}/data/{proxy+}",
                "/{app}/action/{proxy+}",
                "/{app}/form/{proxy+}",
            ];
            for (const routePath of frontendRoutePatterns) {
                httpApi.addRoutes({
                    path: routePath,
                    methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
                    integration: lambdaIntegration,
                    authorizer: frontendAuthorizer,
                });
            }
        }
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
            // CloudFront REQUIRES ACM certificates in us-east-1, regardless of
            // which region this stack is deployed to. We auto-create one via
            // DnsValidatedCertificate which provisions it in us-east-1 with
            // DNS validation through the same hosted zone.
            // -------------------------------------------------------------------
            if (cognitoUserPoolId && cognitoClientId) {
                const cloudfrontCertificate = new acm.DnsValidatedCertificate(this, "CloudFrontCertificate", {
                    domainName: `*.${customDomain}`,
                    hostedZone,
                    region: "us-east-1",
                });
                // CloudFront Function: extract app subdomain → prepend to path
                const cfFunction = new cloudfront.Function(this, "SubdomainRewrite", {
                    code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var host = request.headers.host.value;
  var customDomain = '${customDomain}';
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
                const apiDomainName = cdk.Fn.select(2, cdk.Fn.split("/", httpApi.apiEndpoint)); // extract domain from https://xxx.execute-api...
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
                            cookieBehavior: cloudfront.OriginRequestCookieBehavior.allowList("hereya_id_token"),
                            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList("Content-Type"),
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
                // Route53 wildcard → CloudFront
                new route53.ARecord(this, "WildcardAliasRecord", {
                    zone: hostedZone,
                    recordName: `*.${customDomain}`,
                    target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
                });
                new cdk.CfnOutput(this, "FrontendDistributionDomain", {
                    value: distribution.distributionDomainName,
                });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGVyZXlhLWF3cy1tY3AtYXBwLWxhbWJkYS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImhlcmV5YS1hd3MtbWNwLWFwcC1sYW1iZGEtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsc0RBQXdDO0FBQ3hDLDJDQUErQztBQUMvQywrREFBaUQ7QUFDakQsc0VBQXdEO0FBQ3hELHdGQUEwRTtBQUMxRSx3RUFBMEQ7QUFDMUQseURBQTJDO0FBQzNDLGlFQUFtRDtBQUNuRCx5RUFBMkQ7QUFDM0Qsd0VBQTBEO0FBQzFELHNGQUF3RTtBQUN4RSx1RUFBeUQ7QUFDekQsNEVBQThEO0FBRTlELDJDQUE2QjtBQUU3QixNQUFhLDBCQUEyQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQ3ZELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDOUQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsTUFBTSxvQkFBb0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLHNCQUFzQixDQUFDLENBQUM7UUFDakUsSUFBSSxDQUFDLG9CQUFvQixFQUFFLENBQUM7WUFDMUIsTUFBTSxJQUFJLEtBQUssQ0FBQyx1REFBdUQsQ0FBQyxDQUFDO1FBQzNFLENBQUM7UUFFRCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixDQUFDLENBQUM7UUFDckQsSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO1lBQ3BCLE1BQU0sSUFBSSxLQUFLLENBQUMsaURBQWlELENBQUMsQ0FBQztRQUNyRSxDQUFDO1FBRUQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1FBQ3JELElBQUksQ0FBQyxjQUFjLEVBQUUsQ0FBQztZQUNwQixNQUFNLElBQUksS0FBSyxDQUFDLGlEQUFpRCxD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LEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtnQkFDcEMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxXQUFXO2FBQzNCLENBQUMsQ0FBQztRQUNMLENBQUM7SUFDSCxDQUFDO0NBQ0Y7QUE1YkQsZ0VBNGJDO0FBRUQsU0FBUyxpQkFBaUIsQ0FDeEIsWUFBZ0M7SUFFaEMsSUFBSSxDQUFDLFlBQVk7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUNwQyxNQUFNLEtBQUssR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3RDLElBQUksS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyx1QkFBdUIsR0FBRyxZQUFZLENBQUMsQ0FBQztJQUM5RSxPQUFPLEtBQUssQ0FBQyxNQUFNLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ3RFLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSBcImF3cy1jZGstbGliL2NvcmVcIjtcbmltcG9ydCB7IFNlY3JldFZhbHVlIH0gZnJvbSBcImF3cy1jZGstbGliL2NvcmVcIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgaW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgc2VjcmV0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgKiBhcyB0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGF1dGhvcml6ZXJzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWF1dGhvcml6ZXJzXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcInBhdGhcIjtcblxuZXhwb3J0IGNsYXNzIEhlcmV5YUF3c01jcEFwcExhbWJkYVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgaGVyZXlhUHJvamVjdFJvb3REaXIgPSBwcm9jZXNzLmVudltcImhlcmV5YVByb2plY3RSb290RGlyXCJdO1xuICAgIGlmICghaGVyZXlhUHJvamVjdFJvb3REaXIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcImhlcmV5YVByb2plY3RSb290RGlyIGVudmlyb25tZW50IHZhcmlhYmxlIGlzIHJlcXVpcmVkXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IG9hdXRoU2VydmVyVXJsID0gcHJvY2Vzcy5lbnZbXCJvYXV0aFNlcnZlclVybFwiXTtcbiAgICBpZiAoIW9hdXRoU2VydmVyVXJsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJvYXV0aFNlcnZlclVybCBlbnZpcm9ubWVudCB2YXJpYWJsZSBpcyByZXF1aXJlZFwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBvcmdhbml6YXRpb25JZCA9IHByb2Nlc3MuZW52W1wib3JnYW5pemF0aW9uSWRcIl07XG4gICAgaWYgKCFvcmdhbml6YXRpb25JZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwib3JnYW5pemF0aW9uSWQgZW52aXJvbm1lbnQgdmFyaWFibGUgaXMgcmVxdWlyZWRcIik7XG4gICAgfVxuXG4gICAgY29uc3QgbWVtb3J5U2l6ZSA9IHByb2Nlc3MuZW52W1wibWVtb3J5U2l6ZVwiXVxuICAgICAgPyBwYXJzZUludChwcm9jZXNzLmVudltcIm1lbW9yeVNpemVcIl0pXG4gICAgICA6IDI1NjtcbiAgICBjb25zdCB0aW1lb3V0ID0gcHJvY2Vzcy5lbnZbXCJ0aW1lb3V0XCJdXG4gICAgICA/IHBhcnNlSW50KHByb2Nlc3MuZW52W1widGltZW91dFwiXSlcbiAgICAgIDogMzA7XG4gICAgY29uc3QgaGFuZGxlck5hbWUgPSBwcm9jZXNzLmVudltcImhhbmRsZXJcIl0gPz8gXCJoYW5kbGVyLmhhbmRsZXJcIjtcbiAgICBjb25zdCBjdXN0b21Eb21haW4gPSBwcm9jZXNzLmVudltcImN1c3RvbURvbWFpblwiXTtcbiAgICBjb25zdCBjdXN0b21Eb21haW5ab25lID1cbiAgICAgIHByb2Nlc3MuZW52W1wiY3VzdG9tRG9tYWluWm9uZVwiXSA/PyBleHRyYWN0RG9tYWluWm9uZShjdXN0b21Eb21haW4pO1xuICAgIGNvbnN0IHdpbGRjYXJkQ2VydGlmaWNhdGVBcm4gPSBwcm9jZXNzLmVudltcIndpbGRjYXJkQ2VydGlmaWNhdGVBcm5cIl07XG5cbiAgICAvLyBQYXJzZSBoZXJleWFQcm9qZWN0RW52XG4gICAgY29uc3QgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0gSlNPTi5wYXJzZShcbiAgICAgIHByb2Nlc3MuZW52W1wiaGVyZXlhUHJvamVjdEVudlwiXSA/PyBcInt9XCJcbiAgICApO1xuXG4gICAgLy8gU2VwYXJhdGUgSUFNIHBvbGljeSBlbnYgdmFyc1xuICAgIGNvbnN0IHBvbGljeUVudiA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIE9iamVjdC5lbnRyaWVzKGVudikuZmlsdGVyKFxuICAgICAgICAoW2tleV0pID0+IGtleS5zdGFydHNXaXRoKFwiSUFNX1BPTElDWV9cIikgfHwga2V5LnN0YXJ0c1dpdGgoXCJpYW1Qb2xpY3lcIilcbiAgICAgIClcbiAgICApO1xuXG4gICAgY29uc3Qgbm9uUG9saWN5RW52ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgT2JqZWN0LmVudHJpZXMoZW52KS5maWx0ZXIoXG4gICAgICAgIChba2V5XSkgPT5cbiAgICAgICAgICAha2V5LnN0YXJ0c1dpdGgoXCJJQU1fUE9MSUNZX1wiKSAmJiAha2V5LnN0YXJ0c1dpdGgoXCJpYW1Qb2xpY3lcIilcbiAgICAgIClcbiAgICApO1xuXG4gICAgLy8gU2VwYXJhdGUgc2VjcmV0IGVudiB2YXJzIChzZWNyZXQ6Ly8gcHJlZml4KVxuICAgIGNvbnN0IHNlY3JldEVudkVudHJpZXMgPSBPYmplY3QuZW50cmllcyhub25Qb2xpY3lFbnYpXG4gICAgICAuZmlsdGVyKChbLCB2YWx1ZV0pID0+ICh2YWx1ZSBhcyBzdHJpbmcpLnN0YXJ0c1dpdGgoXCJzZWNyZXQ6Ly9cIikpXG4gICAgICAubWFwKChba2V5LCB2YWx1ZV0pID0+IHtcbiAgICAgICAgY29uc3QgcGxhaW5WYWx1ZSA9ICh2YWx1ZSBhcyBzdHJpbmcpLnNwbGl0KFwic2VjcmV0Oi8vXCIpWzFdO1xuICAgICAgICBjb25zdCBzZWNyZXROYW1lID0gYC8ke3RoaXMuc3RhY2tOYW1lfS8ke2tleX1gO1xuICAgICAgICBjb25zdCBzZWNyZXQgPSBuZXcgc2VjcmV0cy5TZWNyZXQodGhpcywga2V5LCB7XG4gICAgICAgICAgc2VjcmV0TmFtZSxcbiAgICAgICAgICBzZWNyZXRTdHJpbmdWYWx1ZTogU2VjcmV0VmFsdWUudW5zYWZlUGxhaW5UZXh0KHBsYWluVmFsdWUpLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsga2V5LCBzZWNyZXQsIHNlY3JldE5hbWUgfTtcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgcGxhaW5FbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICBPYmplY3QuZW50cmllcyhub25Qb2xpY3lFbnYpLmZpbHRlcihcbiAgICAgICAgKFssIHZhbHVlXSkgPT4gISh2YWx1ZSBhcyBzdHJpbmcpLnN0YXJ0c1dpdGgoXCJzZWNyZXQ6Ly9cIilcbiAgICAgIClcbiAgICApO1xuXG5cbiAgICAvLyBDb2duaXRvIGNvbmZpZyAoZnJvbSBhd3MvY29nbml0byBwYWNrYWdlIG91dHB1dHMgdmlhIGhlcmV5YVByb2plY3RFbnYpXG4gICAgY29uc3QgY29nbml0b1VzZXJQb29sSWQgPSBwbGFpbkVudltcInVzZXJQb29sSWRcIl0gPz8gbm9uUG9saWN5RW52W1widXNlclBvb2xJZFwiXTtcbiAgICBjb25zdCBjb2duaXRvQ2xpZW50SWQgPSBwbGFpbkVudltcInVzZXJQb29sQ2xpZW50SWRcIl0gPz8gbm9uUG9saWN5RW52W1widXNlclBvb2xDbGllbnRJZFwiXTtcbiAgICBjb25zdCBjb2duaXRvUmVnaW9uID0gcGxhaW5FbnZbXCJhd3NDb2duaXRvUmVnaW9uXCJdID8/IG5vblBvbGljeUVudltcImF3c0NvZ25pdG9SZWdpb25cIl0gPz8gcHJvY2Vzcy5lbnZbXCJDREtfREVGQVVMVF9SRUdJT05cIl0gPz8gXCJ1cy1lYXN0LTFcIjtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gTGFtYmRhIDE6IEFwcCBIYW5kbGVyIChPcmcgTGFtYmRhIOKAlCBNQ1AgKyBmcm9udGVuZCByb3V0ZXMpXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IGZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIkhhbmRsZXJcIiwge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICBoYW5kbGVyOiBoYW5kbGVyTmFtZSxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oaGVyZXlhUHJvamVjdFJvb3REaXIsIFwiZGlzdFwiKSksXG4gICAgICBtZW1vcnlTaXplLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHModGltZW91dCksXG4gICAgICBlbnZpcm9ubWVudDogcGxhaW5FbnYsXG4gICAgfSk7XG5cbiAgICAvLyBBdHRhY2ggc2VjcmV0IHJlZmVyZW5jZXMgKHNlY3JldCBuYW1lLCBub3QgdmFsdWUpIGFuZCBncmFudCByZWFkIGFjY2Vzc1xuICAgIGNvbnN0IHNlY3JldEtleXM6IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChjb25zdCB7IGtleSwgc2VjcmV0LCBzZWNyZXROYW1lIH0gb2Ygc2VjcmV0RW52RW50cmllcykge1xuICAgICAgZm4uYWRkRW52aXJvbm1lbnQoa2V5LCBzZWNyZXROYW1lKTtcbiAgICAgIHNlY3JldC5ncmFudFJlYWQoZm4pO1xuICAgICAgc2VjcmV0S2V5cy5wdXNoKGtleSk7XG4gICAgfVxuICAgIGlmIChzZWNyZXRLZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgIGZuLmFkZEVudmlyb25tZW50KFwiU0VDUkVUX0tFWVNcIiwgc2VjcmV0S2V5cy5qb2luKFwiLFwiKSk7XG4gICAgfVxuXG4gICAgLy8gQXR0YWNoIElBTSBwb2xpY2llcyBmcm9tIGRlcGVuZGVuY3kgcGFja2FnZXNcbiAgICBmb3IgKGNvbnN0IFssIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwb2xpY3lFbnYpKSB7XG4gICAgICBjb25zdCBwb2xpY3kgPSBKU09OLnBhcnNlKHZhbHVlIGFzIHN0cmluZyk7XG4gICAgICBmb3IgKGNvbnN0IHN0YXRlbWVudCBvZiBwb2xpY3kuU3RhdGVtZW50KSB7XG4gICAgICAgIGZuLmFkZFRvUm9sZVBvbGljeShpYW0uUG9saWN5U3RhdGVtZW50LmZyb21Kc29uKHN0YXRlbWVudCkpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gTUNQIE9BdXRoIEF1dGhvcml6ZXIgTGFtYmRhXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IGF1dGhvcml6ZXJGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJBdXRob3JpemVySGFuZGxlclwiLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWCxcbiAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsIFwiYXV0aG9yaXplclwiKSksXG4gICAgICBtZW1vcnlTaXplOiAxMjgsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBPQVVUSF9TRVJWRVJfVVJMOiBvYXV0aFNlcnZlclVybCxcbiAgICAgICAgQk9VTkRfT1JHX0lEOiBvcmdhbml6YXRpb25JZCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBodHRwQXV0aG9yaXplciA9IG5ldyBhdXRob3JpemVycy5IdHRwTGFtYmRhQXV0aG9yaXplcihcbiAgICAgIFwiSGVyZXlhQXV0aG9yaXplclwiLFxuICAgICAgYXV0aG9yaXplckZuLFxuICAgICAge1xuICAgICAgICByZXNwb25zZVR5cGVzOiBbYXV0aG9yaXplcnMuSHR0cExhbWJkYVJlc3BvbnNlVHlwZS5TSU1QTEVdLFxuICAgICAgICByZXN1bHRzQ2FjaGVUdGw6IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgfVxuICAgICk7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIEhUVFAgQVBJXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGNvbnN0IGh0dHBBcGkgPSBuZXcgYXBpZ3d2Mi5IdHRwQXBpKHRoaXMsIFwiSHR0cEFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiB0aGlzLnN0YWNrTmFtZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGxhbWJkYUludGVncmF0aW9uID0gbmV3IGludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICBcIkxhbWJkYUludGVncmF0aW9uXCIsXG4gICAgICBmblxuICAgICk7XG5cbiAgICAvLyBDb21wdXRlIHNlcnZpY2UgVVJMIGZvciBQUk0gKGN1c3RvbSBkb21haW4gb3IgQVBJIGVuZHBvaW50KVxuICAgIGNvbnN0IHNlcnZpY2VVcmwgPSBjdXN0b21Eb21haW5cbiAgICAgID8gYGh0dHBzOi8vJHtjdXN0b21Eb21haW59YFxuICAgICAgOiBodHRwQXBpLmFwaUVuZHBvaW50O1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBQcm90ZWN0ZWQgUmVzb3VyY2UgTWV0YWRhdGEgKFJGQyA5NzI4KVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBjb25zdCBwcm1MYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiUHJtSGFuZGxlclwiLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWCxcbiAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUlubGluZShgXG4gICAgICAgIGV4cG9ydHMuaGFuZGxlciA9IGFzeW5jICgpID0+ICh7XG4gICAgICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgICAgICAgXCJDYWNoZS1Db250cm9sXCI6IFwicHVibGljLCBtYXgtYWdlPTM2MDBcIixcbiAgICAgICAgICAgIFwiQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IFwiKlwiLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgcmVzb3VyY2U6IHByb2Nlc3MuZW52LlNFUlZJQ0VfVVJMICsgXCIvbWNwXCIsXG4gICAgICAgICAgICBhdXRob3JpemF0aW9uX3NlcnZlcnM6IFtwcm9jZXNzLmVudi5PQVVUSF9TRVJWRVJfVVJMICsgXCIvb2F1dGgvXCIgKyBwcm9jZXNzLmVudi5PUkdBTklaQVRJT05fSURdLFxuICAgICAgICAgICAgYmVhcmVyX21ldGhvZHNfc3VwcG9ydGVkOiBbXCJoZWFkZXJcIl0sXG4gICAgICAgICAgICBzY29wZXNfc3VwcG9ydGVkOiBbXCJtY3A6YWNjZXNzXCJdLFxuICAgICAgICAgIH0pLFxuICAgICAgICB9KTtcbiAgICAgIGApLFxuICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBTRVJWSUNFX1VSTDogc2VydmljZVVybCxcbiAgICAgICAgT0FVVEhfU0VSVkVSX1VSTDogb2F1dGhTZXJ2ZXJVcmwsXG4gICAgICAgIE9SR0FOSVpBVElPTl9JRDogb3JnYW5pemF0aW9uSWQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgaHR0cEFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogXCIvLndlbGwta25vd24vb2F1dGgtcHJvdGVjdGVkLXJlc291cmNlXCIsXG4gICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogbmV3IGludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIFwiUHJtSW50ZWdyYXRpb25cIixcbiAgICAgICAgcHJtTGFtYmRhXG4gICAgICApLFxuICAgIH0pO1xuXG4gICAgLy8gTUNQIHJvdXRlIChleGlzdGluZylcbiAgICBodHRwQXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiBcIi9tY3BcIixcbiAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogbGFtYmRhSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiBodHRwQXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gRnJvbnRlbmQgQXV0aG9yaXplciBMYW1iZGEgKENvZ25pdG8gSldUIGNvb2tpZSB2YWxpZGF0aW9uKVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBsZXQgZnJvbnRlbmRBdXRob3JpemVyOiBhdXRob3JpemVycy5IdHRwTGFtYmRhQXV0aG9yaXplciB8IHVuZGVmaW5lZDtcblxuICAgIGlmIChjb2duaXRvVXNlclBvb2xJZCAmJiBjb2duaXRvQ2xpZW50SWQpIHtcbiAgICAgIGNvbnN0IGZyb250ZW5kQXV0aG9yaXplckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbihcbiAgICAgICAgdGhpcyxcbiAgICAgICAgXCJGcm9udGVuZEF1dGhvcml6ZXJIYW5kbGVyXCIsXG4gICAgICAgIHtcbiAgICAgICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWCxcbiAgICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoXG4gICAgICAgICAgICBwYXRoLmpvaW4oX19kaXJuYW1lLCBcImZyb250ZW5kLWF1dGhvcml6ZXJcIilcbiAgICAgICAgICApLFxuICAgICAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICAgIENPR05JVE9fVVNFUl9QT09MX0lEOiBjb2duaXRvVXNlclBvb2xJZCxcbiAgICAgICAgICAgIENPR05JVE9fUkVHSU9OOiBjb2duaXRvUmVnaW9uLFxuICAgICAgICAgIH0sXG4gICAgICAgIH1cbiAgICAgICk7XG5cbiAgICAgIGZyb250ZW5kQXV0aG9yaXplciA9IG5ldyBhdXRob3JpemVycy5IdHRwTGFtYmRhQXV0aG9yaXplcihcbiAgICAgICAgXCJGcm9udGVuZEF1dGhvcml6ZXJcIixcbiAgICAgICAgZnJvbnRlbmRBdXRob3JpemVyRm4sXG4gICAgICAgIHtcbiAgICAgICAgICByZXNwb25zZVR5cGVzOiBbYXV0aG9yaXplcnMuSHR0cExhbWJkYVJlc3BvbnNlVHlwZS5TSU1QTEVdLFxuICAgICAgICAgIHJlc3VsdHNDYWNoZVR0bDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMCksIC8vIE5vIGNhY2hpbmcg4oCUIGNvb2tpZS1iYXNlZFxuICAgICAgICAgIGlkZW50aXR5U291cmNlOiBbXCIkcmVxdWVzdC5oZWFkZXIuQ29va2llXCJdLFxuICAgICAgICB9XG4gICAgICApO1xuXG4gICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICAvLyBBdXRoIExhbWJkYSAobG9naW4vT1RQL3ZlcmlmeS9sb2dvdXQpXG4gICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAgIGNvbnN0IGF1dGhMYW1iZGFFbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICAgIENPR05JVE9fVVNFUl9QT09MX0lEOiBjb2duaXRvVXNlclBvb2xJZCxcbiAgICAgICAgQ09HTklUT19DTElFTlRfSUQ6IGNvZ25pdG9DbGllbnRJZCxcbiAgICAgICAgQ09HTklUT19SRUdJT046IGNvZ25pdG9SZWdpb24sXG4gICAgICAgIENVU1RPTV9ET01BSU46IGN1c3RvbURvbWFpbiA/PyBcIlwiLFxuICAgICAgfTtcblxuICAgICAgY29uc3QgYXV0aExhbWJkYUZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIkF1dGhMYW1iZGFIYW5kbGVyXCIsIHtcbiAgICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgXCJhdXRoLWxhbWJkYVwiKSksXG4gICAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTUpLFxuICAgICAgICBlbnZpcm9ubWVudDogYXV0aExhbWJkYUVudixcbiAgICAgIH0pO1xuXG4gICAgICAvLyBHcmFudCBBdXRoIExhbWJkYSBhY2Nlc3MgdG8gYWxsIHNlY3JldHMgZnJvbSBoZXJleWFQcm9qZWN0RW52XG4gICAgICAvLyAoc2FtZSBzZWNyZXRzIGFscmVhZHkgY3JlYXRlZCBmb3IgdGhlIG1haW4gaGFuZGxlciDigJQgcmV1c2UgdGhlbSlcbiAgICAgIGNvbnN0IGF1dGhTZWNyZXRLZXlzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgZm9yIChjb25zdCB7IGtleSwgc2VjcmV0LCBzZWNyZXROYW1lIH0gb2Ygc2VjcmV0RW52RW50cmllcykge1xuICAgICAgICBhdXRoTGFtYmRhRm4uYWRkRW52aXJvbm1lbnQoa2V5LCBzZWNyZXROYW1lKTtcbiAgICAgICAgc2VjcmV0LmdyYW50UmVhZChhdXRoTGFtYmRhRm4pO1xuICAgICAgICBhdXRoU2VjcmV0S2V5cy5wdXNoKGtleSk7XG4gICAgICB9XG4gICAgICBpZiAoYXV0aFNlY3JldEtleXMubGVuZ3RoID4gMCkge1xuICAgICAgICBhdXRoTGFtYmRhRm4uYWRkRW52aXJvbm1lbnQoXCJTRUNSRVRfS0VZU1wiLCBhdXRoU2VjcmV0S2V5cy5qb2luKFwiLFwiKSk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGF1dGhMYW1iZGFJbnRlZ3JhdGlvbiA9IG5ldyBpbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBcIkF1dGhMYW1iZGFJbnRlZ3JhdGlvblwiLFxuICAgICAgICBhdXRoTGFtYmRhRm5cbiAgICAgICk7XG5cbiAgICAgIC8vIEF1dGggcm91dGVzIChubyBhdXRob3JpemVyIOKAlCBhbHdheXMgYWNjZXNzaWJsZSlcbiAgICAgIGh0dHBBcGkuYWRkUm91dGVzKHtcbiAgICAgICAgcGF0aDogXCIve2FwcH0vYXV0aC97cHJveHkrfVwiLFxuICAgICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1RdLFxuICAgICAgICBpbnRlZ3JhdGlvbjogYXV0aExhbWJkYUludGVncmF0aW9uLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEZyb250ZW5kIHJvdXRlcyAod2l0aCBGcm9udGVuZCBBdXRob3JpemVyIOKGkiBPcmcgTGFtYmRhKVxuICAgICAgY29uc3QgZnJvbnRlbmRSb3V0ZVBhdHRlcm5zID0gW1xuICAgICAgICBcIi97YXBwfS92aWV3L3twcm94eSt9XCIsXG4gICAgICAgIFwiL3thcHB9L2RhdGEve3Byb3h5K31cIixcbiAgICAgICAgXCIve2FwcH0vYWN0aW9uL3twcm94eSt9XCIsXG4gICAgICAgIFwiL3thcHB9L2Zvcm0ve3Byb3h5K31cIixcbiAgICAgIF07XG5cbiAgICAgIGZvciAoY29uc3Qgcm91dGVQYXRoIG9mIGZyb250ZW5kUm91dGVQYXR0ZXJucykge1xuICAgICAgICBodHRwQXBpLmFkZFJvdXRlcyh7XG4gICAgICAgICAgcGF0aDogcm91dGVQYXRoLFxuICAgICAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuR0VULCBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICAgICAgaW50ZWdyYXRpb246IGxhbWJkYUludGVncmF0aW9uLFxuICAgICAgICAgIGF1dGhvcml6ZXI6IGZyb250ZW5kQXV0aG9yaXplcixcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBDdXN0b20gZG9tYWluICsgRE5TXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGlmIChjdXN0b21Eb21haW4gJiYgY3VzdG9tRG9tYWluWm9uZSkge1xuICAgICAgaWYgKCF3aWxkY2FyZENlcnRpZmljYXRlQXJuKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIndpbGRjYXJkQ2VydGlmaWNhdGVBcm4gaXMgcmVxdWlyZWQgd2hlbiBjdXN0b21Eb21haW4gaXMgc2V0XCJcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgY2VydGlmaWNhdGUgPSBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKFxuICAgICAgICB0aGlzLFxuICAgICAgICBcIkNlcnRpZmljYXRlXCIsXG4gICAgICAgIHdpbGRjYXJkQ2VydGlmaWNhdGVBcm5cbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IGhvc3RlZFpvbmUgPSByb3V0ZTUzLkhvc3RlZFpvbmUuZnJvbUxvb2t1cCh0aGlzLCBcIkhvc3RlZFpvbmVcIiwge1xuICAgICAgICBkb21haW5OYW1lOiBjdXN0b21Eb21haW5ab25lLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEFQSSBHYXRld2F5IGN1c3RvbSBkb21haW4gZm9yIE1DUCAoZXhhY3QgZG9tYWluKVxuICAgICAgY29uc3QgZG9tYWluTmFtZSA9IG5ldyBhcGlnd3YyLkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgICAgZG9tYWluTmFtZTogY3VzdG9tRG9tYWluLFxuICAgICAgICBjZXJ0aWZpY2F0ZSxcbiAgICAgIH0pO1xuXG4gICAgICBuZXcgYXBpZ3d2Mi5BcGlNYXBwaW5nKHRoaXMsIFwiQXBpTWFwcGluZ1wiLCB7XG4gICAgICAgIGFwaTogaHR0cEFwaSxcbiAgICAgICAgZG9tYWluTmFtZSxcbiAgICAgIH0pO1xuXG4gICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiBjdXN0b21Eb21haW4sXG4gICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKFxuICAgICAgICAgIG5ldyB0YXJnZXRzLkFwaUdhdGV3YXl2MkRvbWFpblByb3BlcnRpZXMoXG4gICAgICAgICAgICBkb21haW5OYW1lLnJlZ2lvbmFsRG9tYWluTmFtZSxcbiAgICAgICAgICAgIGRvbWFpbk5hbWUucmVnaW9uYWxIb3N0ZWRab25lSWRcbiAgICAgICAgICApXG4gICAgICAgICksXG4gICAgICB9KTtcblxuICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgLy8gQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gZm9yIGZyb250ZW5kICgqLntjdXN0b21Eb21haW59KVxuICAgICAgLy8gQ2xvdWRGcm9udCBSRVFVSVJFUyBBQ00gY2VydGlmaWNhdGVzIGluIHVzLWVhc3QtMSwgcmVnYXJkbGVzcyBvZlxuICAgICAgLy8gd2hpY2ggcmVnaW9uIHRoaXMgc3RhY2sgaXMgZGVwbG95ZWQgdG8uIFdlIGF1dG8tY3JlYXRlIG9uZSB2aWFcbiAgICAgIC8vIERuc1ZhbGlkYXRlZENlcnRpZmljYXRlIHdoaWNoIHByb3Zpc2lvbnMgaXQgaW4gdXMtZWFzdC0xIHdpdGhcbiAgICAgIC8vIEROUyB2YWxpZGF0aW9uIHRocm91Z2ggdGhlIHNhbWUgaG9zdGVkIHpvbmUuXG4gICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAgIGlmIChjb2duaXRvVXNlclBvb2xJZCAmJiBjb2duaXRvQ2xpZW50SWQpIHtcbiAgICAgICAgY29uc3QgY2xvdWRmcm9udENlcnRpZmljYXRlID0gbmV3IGFjbS5EbnNWYWxpZGF0ZWRDZXJ0aWZpY2F0ZShcbiAgICAgICAgICB0aGlzLFxuICAgICAgICAgIFwiQ2xvdWRGcm9udENlcnRpZmljYXRlXCIsXG4gICAgICAgICAge1xuICAgICAgICAgICAgZG9tYWluTmFtZTogYCouJHtjdXN0b21Eb21haW59YCxcbiAgICAgICAgICAgIGhvc3RlZFpvbmUsXG4gICAgICAgICAgICByZWdpb246IFwidXMtZWFzdC0xXCIsXG4gICAgICAgICAgfVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIENsb3VkRnJvbnQgRnVuY3Rpb246IGV4dHJhY3QgYXBwIHN1YmRvbWFpbiDihpIgcHJlcGVuZCB0byBwYXRoXG4gICAgICAgIGNvbnN0IGNmRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlN1YmRvbWFpblJld3JpdGVcIiwge1xuICAgICAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21JbmxpbmUoYFxuZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuICB2YXIgcmVxdWVzdCA9IGV2ZW50LnJlcXVlc3Q7XG4gIHZhciBob3N0ID0gcmVxdWVzdC5oZWFkZXJzLmhvc3QudmFsdWU7XG4gIHZhciBjdXN0b21Eb21haW4gPSAnJHtjdXN0b21Eb21haW59JztcbiAgaWYgKGhvc3QgIT09IGN1c3RvbURvbWFpbiAmJiBob3N0LmVuZHNXaXRoKCcuJyArIGN1c3RvbURvbWFpbikpIHtcbiAgICB2YXIgYXBwTmFtZSA9IGhvc3Quc2xpY2UoMCwgLShjdXN0b21Eb21haW4ubGVuZ3RoICsgMSkpO1xuICAgIHJlcXVlc3QudXJpID0gJy8nICsgYXBwTmFtZSArIHJlcXVlc3QudXJpO1xuICB9XG4gIHJldHVybiByZXF1ZXN0O1xufVxuICAgICAgICAgIGApLFxuICAgICAgICAgIGZ1bmN0aW9uTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LXN1YmRvbWFpbi1yZXdyaXRlYCxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQVBJIEdhdGV3YXkgb3JpZ2luXG4gICAgICAgIGNvbnN0IGFwaURvbWFpbk5hbWUgPSBjZGsuRm4uc2VsZWN0KFxuICAgICAgICAgIDIsXG4gICAgICAgICAgY2RrLkZuLnNwbGl0KFwiL1wiLCBodHRwQXBpLmFwaUVuZHBvaW50KVxuICAgICAgICApOyAvLyBleHRyYWN0IGRvbWFpbiBmcm9tIGh0dHBzOi8veHh4LmV4ZWN1dGUtYXBpLi4uXG5cbiAgICAgICAgY29uc3QgZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKFxuICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgXCJGcm9udGVuZERpc3RyaWJ1dGlvblwiLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGNlcnRpZmljYXRlOiBjbG91ZGZyb250Q2VydGlmaWNhdGUsXG4gICAgICAgICAgICBkb21haW5OYW1lczogW2AqLiR7Y3VzdG9tRG9tYWlufWBdLFxuICAgICAgICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XG4gICAgICAgICAgICAgIG9yaWdpbjogbmV3IG9yaWdpbnMuSHR0cE9yaWdpbihhcGlEb21haW5OYW1lLCB7XG4gICAgICAgICAgICAgICAgcHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUHJvdG9jb2xQb2xpY3kuSFRUUFNfT05MWSxcbiAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OlxuICAgICAgICAgICAgICAgIGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRCxcbiAgICAgICAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeShcbiAgICAgICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgICAgIFwiRnJvbnRlbmRPcmlnaW5Qb2xpY3lcIixcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBjb29raWVCZWhhdmlvcjpcbiAgICAgICAgICAgICAgICAgICAgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3IuYWxsb3dMaXN0KFxuICAgICAgICAgICAgICAgICAgICAgIFwiaGVyZXlhX2lkX3Rva2VuXCJcbiAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgIGhlYWRlckJlaGF2aW9yOlxuICAgICAgICAgICAgICAgICAgICBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoXG4gICAgICAgICAgICAgICAgICAgICAgXCJDb250ZW50LVR5cGVcIlxuICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjpcbiAgICAgICAgICAgICAgICAgICAgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgZnVuY3Rpb246IGNmRnVuY3Rpb24sXG4gICAgICAgICAgICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25FdmVudFR5cGUuVklFV0VSX1JFUVVFU1QsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIFJvdXRlNTMgd2lsZGNhcmQg4oaSIENsb3VkRnJvbnRcbiAgICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIldpbGRjYXJkQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICAgIHpvbmU6IGhvc3RlZFpvbmUsXG4gICAgICAgICAgcmVjb3JkTmFtZTogYCouJHtjdXN0b21Eb21haW59YCxcbiAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhcbiAgICAgICAgICAgIG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQoZGlzdHJpYnV0aW9uKVxuICAgICAgICAgICksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiRnJvbnRlbmREaXN0cmlidXRpb25Eb21haW5cIiwge1xuICAgICAgICAgIHZhbHVlOiBkaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uRG9tYWluTmFtZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiU2VydmljZVVybFwiLCB7XG4gICAgICAgIHZhbHVlOiBgaHR0cHM6Ly8ke2N1c3RvbURvbWFpbn1gLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiU2VydmljZVVybFwiLCB7XG4gICAgICAgIHZhbHVlOiBodHRwQXBpLmFwaUVuZHBvaW50LFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3REb21haW5ab25lKFxuICBjdXN0b21Eb21haW46IHN0cmluZyB8IHVuZGVmaW5lZFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFjdXN0b21Eb21haW4pIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHBhcnRzID0gY3VzdG9tRG9tYWluLnNwbGl0KFwiLlwiKTtcbiAgaWYgKHBhcnRzLmxlbmd0aCA8IDIpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgZG9tYWluIG5hbWU6IFwiICsgY3VzdG9tRG9tYWluKTtcbiAgcmV0dXJuIHBhcnRzLmxlbmd0aCA9PT0gMiA/IGN1c3RvbURvbWFpbiA6IHBhcnRzLnNsaWNlKDEpLmpvaW4oXCIuXCIpO1xufVxuIl19