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
                identitySource: [], // No identity source — always invoke authorizer (supports public endpoints without cookies)
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
            // Grant Auth Lambda Cognito permissions (same IAM policies as main handler)
            for (const [, value] of Object.entries(policyEnv)) {
                const policy = JSON.parse(value);
                for (const statement of policy.Statement) {
                    authLambdaFn.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
                }
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
            // Catch-all for unmatched frontend paths (e.g., /{app}/ root)
            // More specific routes above take priority in API Gateway HTTP API
            httpApi.addRoutes({
                path: "/{proxy+}",
                methods: [apigwv2.HttpMethod.GET],
                integration: lambdaIntegration,
                authorizer: frontendAuthorizer,
            });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGVyZXlhLWF3cy1tY3AtYXBwLWxhbWJkYS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImhlcmV5YS1hd3MtbWNwLWFwcC1sYW1iZGEtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsc0RBQXdDO0FBQ3hDLDJDQUErQztBQUMvQywrREFBaUQ7QUFDakQsc0VBQXdEO0FBQ3hELHdGQUEwRTtBQUMxRSx3RUFBMEQ7QUFDMUQseURBQTJDO0FBQzNDLGlFQUFtRDtBQUNuRCx5RUFBMkQ7QUFDM0Qsd0VBQTBEO0FBQzFELHNGQUF3RTtBQUN4RSx1RUFBeUQ7QUFDekQsNEVBQThEO0FBRTlELDJDQUE2QjtBQUU3QixNQUFhLDBCQUEyQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQ3ZELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDOUQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsTUFBTSxvQkFBb0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLHNCQUFzQixDQUFDLENBQUM7UUFDakUsSUFBSSxDQUFDLG9CQUFvQixFQUFFLENBQUM7WUFDMUIsTUFBTSxJQUFJLEtBQUssQ0FBQyx1REFBdUQsQ0FBQyxDQUFDO1FBQzNFLENBQUM7UUFFRCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixDQUFDLENBQUM7UUFDckQsSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO1lBQ3BCLE1BQU0sSUFBSSxLQUFLLENBQUMsaURBQWlELENBQUMsQ0FBQztRQUNyRSxDQUFDO1FBRUQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1FBQ3JELElBQUksQ0FBQyxjQUFjLEVBQUUsQ0FBQztZQUNwQixNQUFNLElBQUksS0FBSyxDQUFDLGlEQUFpRCxD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LEdBQUcsWUFBWSxDQUFDLENBQUM7SUFDOUUsT0FBTyxLQUFLLENBQUMsTUFBTSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN0RSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gXCJhd3MtY2RrLWxpYi9jb3JlXCI7XG5pbXBvcnQgeyBTZWNyZXRWYWx1ZSB9IGZyb20gXCJhd3MtY2RrLWxpYi9jb3JlXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIHNlY3JldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zZWNyZXRzbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnRcIjtcbmltcG9ydCAqIGFzIG9yaWdpbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250LW9yaWdpbnNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gXCJwYXRoXCI7XG5cbmV4cG9ydCBjbGFzcyBIZXJleWFBd3NNY3BBcHBMYW1iZGFTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIGNvbnN0IGhlcmV5YVByb2plY3RSb290RGlyID0gcHJvY2Vzcy5lbnZbXCJoZXJleWFQcm9qZWN0Um9vdERpclwiXTtcbiAgICBpZiAoIWhlcmV5YVByb2plY3RSb290RGlyKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJoZXJleWFQcm9qZWN0Um9vdERpciBlbnZpcm9ubWVudCB2YXJpYWJsZSBpcyByZXF1aXJlZFwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBvYXV0aFNlcnZlclVybCA9IHByb2Nlc3MuZW52W1wib2F1dGhTZXJ2ZXJVcmxcIl07XG4gICAgaWYgKCFvYXV0aFNlcnZlclVybCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwib2F1dGhTZXJ2ZXJVcmwgZW52aXJvbm1lbnQgdmFyaWFibGUgaXMgcmVxdWlyZWRcIik7XG4gICAgfVxuXG4gICAgY29uc3Qgb3JnYW5pemF0aW9uSWQgPSBwcm9jZXNzLmVudltcIm9yZ2FuaXphdGlvbklkXCJdO1xuICAgIGlmICghb3JnYW5pemF0aW9uSWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIm9yZ2FuaXphdGlvbklkIGVudmlyb25tZW50IHZhcmlhYmxlIGlzIHJlcXVpcmVkXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IG1lbW9yeVNpemUgPSBwcm9jZXNzLmVudltcIm1lbW9yeVNpemVcIl1cbiAgICAgID8gcGFyc2VJbnQocHJvY2Vzcy5lbnZbXCJtZW1vcnlTaXplXCJdKVxuICAgICAgOiAyNTY7XG4gICAgY29uc3QgdGltZW91dCA9IHByb2Nlc3MuZW52W1widGltZW91dFwiXVxuICAgICAgPyBwYXJzZUludChwcm9jZXNzLmVudltcInRpbWVvdXRcIl0pXG4gICAgICA6IDMwO1xuICAgIGNvbnN0IGhhbmRsZXJOYW1lID0gcHJvY2Vzcy5lbnZbXCJoYW5kbGVyXCJdID8/IFwiaGFuZGxlci5oYW5kbGVyXCI7XG4gICAgY29uc3QgY3VzdG9tRG9tYWluID0gcHJvY2Vzcy5lbnZbXCJjdXN0b21Eb21haW5cIl07XG4gICAgY29uc3QgY3VzdG9tRG9tYWluWm9uZSA9XG4gICAgICBwcm9jZXNzLmVudltcImN1c3RvbURvbWFpblpvbmVcIl0gPz8gZXh0cmFjdERvbWFpblpvbmUoY3VzdG9tRG9tYWluKTtcbiAgICBjb25zdCB3aWxkY2FyZENlcnRpZmljYXRlQXJuID0gcHJvY2Vzcy5lbnZbXCJ3aWxkY2FyZENlcnRpZmljYXRlQXJuXCJdO1xuXG4gICAgLy8gUGFyc2UgaGVyZXlhUHJvamVjdEVudlxuICAgIGNvbnN0IGVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IEpTT04ucGFyc2UoXG4gICAgICBwcm9jZXNzLmVudltcImhlcmV5YVByb2plY3RFbnZcIl0gPz8gXCJ7fVwiXG4gICAgKTtcblxuICAgIC8vIFNlcGFyYXRlIElBTSBwb2xpY3kgZW52IHZhcnNcbiAgICBjb25zdCBwb2xpY3lFbnYgPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICBPYmplY3QuZW50cmllcyhlbnYpLmZpbHRlcihcbiAgICAgICAgKFtrZXldKSA9PiBrZXkuc3RhcnRzV2l0aChcIklBTV9QT0xJQ1lfXCIpIHx8IGtleS5zdGFydHNXaXRoKFwiaWFtUG9saWN5XCIpXG4gICAgICApXG4gICAgKTtcblxuICAgIGNvbnN0IG5vblBvbGljeUVudiA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIE9iamVjdC5lbnRyaWVzKGVudikuZmlsdGVyKFxuICAgICAgICAoW2tleV0pID0+XG4gICAgICAgICAgIWtleS5zdGFydHNXaXRoKFwiSUFNX1BPTElDWV9cIikgJiYgIWtleS5zdGFydHNXaXRoKFwiaWFtUG9saWN5XCIpXG4gICAgICApXG4gICAgKTtcblxuICAgIC8vIFNlcGFyYXRlIHNlY3JldCBlbnYgdmFycyAoc2VjcmV0Oi8vIHByZWZpeClcbiAgICBjb25zdCBzZWNyZXRFbnZFbnRyaWVzID0gT2JqZWN0LmVudHJpZXMobm9uUG9saWN5RW52KVxuICAgICAgLmZpbHRlcigoWywgdmFsdWVdKSA9PiAodmFsdWUgYXMgc3RyaW5nKS5zdGFydHNXaXRoKFwic2VjcmV0Oi8vXCIpKVxuICAgICAgLm1hcCgoW2tleSwgdmFsdWVdKSA9PiB7XG4gICAgICAgIGNvbnN0IHBsYWluVmFsdWUgPSAodmFsdWUgYXMgc3RyaW5nKS5zcGxpdChcInNlY3JldDovL1wiKVsxXTtcbiAgICAgICAgY29uc3Qgc2VjcmV0TmFtZSA9IGAvJHt0aGlzLnN0YWNrTmFtZX0vJHtrZXl9YDtcbiAgICAgICAgY29uc3Qgc2VjcmV0ID0gbmV3IHNlY3JldHMuU2VjcmV0KHRoaXMsIGtleSwge1xuICAgICAgICAgIHNlY3JldE5hbWUsXG4gICAgICAgICAgc2VjcmV0U3RyaW5nVmFsdWU6IFNlY3JldFZhbHVlLnVuc2FmZVBsYWluVGV4dChwbGFpblZhbHVlKSxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGtleSwgc2VjcmV0LCBzZWNyZXROYW1lIH07XG4gICAgICB9KTtcblxuICAgIGNvbnN0IHBsYWluRW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgT2JqZWN0LmVudHJpZXMobm9uUG9saWN5RW52KS5maWx0ZXIoXG4gICAgICAgIChbLCB2YWx1ZV0pID0+ICEodmFsdWUgYXMgc3RyaW5nKS5zdGFydHNXaXRoKFwic2VjcmV0Oi8vXCIpXG4gICAgICApXG4gICAgKTtcblxuXG4gICAgLy8gQ29nbml0byBjb25maWcgKGZyb20gYXdzL2NvZ25pdG8gcGFja2FnZSBvdXRwdXRzIHZpYSBoZXJleWFQcm9qZWN0RW52KVxuICAgIGNvbnN0IGNvZ25pdG9Vc2VyUG9vbElkID0gcGxhaW5FbnZbXCJ1c2VyUG9vbElkXCJdID8/IG5vblBvbGljeUVudltcInVzZXJQb29sSWRcIl07XG4gICAgY29uc3QgY29nbml0b0NsaWVudElkID0gcGxhaW5FbnZbXCJ1c2VyUG9vbENsaWVudElkXCJdID8/IG5vblBvbGljeUVudltcInVzZXJQb29sQ2xpZW50SWRcIl07XG4gICAgY29uc3QgY29nbml0b1JlZ2lvbiA9IHBsYWluRW52W1wiYXdzQ29nbml0b1JlZ2lvblwiXSA/PyBub25Qb2xpY3lFbnZbXCJhd3NDb2duaXRvUmVnaW9uXCJdID8/IHByb2Nlc3MuZW52W1wiQ0RLX0RFRkFVTFRfUkVHSU9OXCJdID8/IFwidXMtZWFzdC0xXCI7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIExhbWJkYSAxOiBBcHAgSGFuZGxlciAoT3JnIExhbWJkYSDigJQgTUNQICsgZnJvbnRlbmQgcm91dGVzKVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAvLyBQYXNzIGRlcGxveS10aW1lIGNvbmZpZyB2YXJzIHRvIHRoZSBoYW5kbGVyIChub3QgaW4gaGVyZXlhUHJvamVjdEVudilcbiAgICBpZiAoY3VzdG9tRG9tYWluKSB7XG4gICAgICBwbGFpbkVudltcImN1c3RvbURvbWFpblwiXSA9IGN1c3RvbURvbWFpbjtcbiAgICB9XG5cbiAgICBjb25zdCBmbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJIYW5kbGVyXCIsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YLFxuICAgICAgaGFuZGxlcjogaGFuZGxlck5hbWUsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKGhlcmV5YVByb2plY3RSb290RGlyLCBcImRpc3RcIikpLFxuICAgICAgbWVtb3J5U2l6ZSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKHRpbWVvdXQpLFxuICAgICAgZW52aXJvbm1lbnQ6IHBsYWluRW52LFxuICAgIH0pO1xuXG4gICAgLy8gQXR0YWNoIHNlY3JldCByZWZlcmVuY2VzIChzZWNyZXQgbmFtZSwgbm90IHZhbHVlKSBhbmQgZ3JhbnQgcmVhZCBhY2Nlc3NcbiAgICBjb25zdCBzZWNyZXRLZXlzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgeyBrZXksIHNlY3JldCwgc2VjcmV0TmFtZSB9IG9mIHNlY3JldEVudkVudHJpZXMpIHtcbiAgICAgIGZuLmFkZEVudmlyb25tZW50KGtleSwgc2VjcmV0TmFtZSk7XG4gICAgICBzZWNyZXQuZ3JhbnRSZWFkKGZuKTtcbiAgICAgIHNlY3JldEtleXMucHVzaChrZXkpO1xuICAgIH1cbiAgICBpZiAoc2VjcmV0S2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICBmbi5hZGRFbnZpcm9ubWVudChcIlNFQ1JFVF9LRVlTXCIsIHNlY3JldEtleXMuam9pbihcIixcIikpO1xuICAgIH1cblxuICAgIC8vIEF0dGFjaCBJQU0gcG9saWNpZXMgZnJvbSBkZXBlbmRlbmN5IHBhY2thZ2VzXG4gICAgZm9yIChjb25zdCBbLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocG9saWN5RW52KSkge1xuICAgICAgY29uc3QgcG9saWN5ID0gSlNPTi5wYXJzZSh2YWx1ZSBhcyBzdHJpbmcpO1xuICAgICAgZm9yIChjb25zdCBzdGF0ZW1lbnQgb2YgcG9saWN5LlN0YXRlbWVudCkge1xuICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3koaWFtLlBvbGljeVN0YXRlbWVudC5mcm9tSnNvbihzdGF0ZW1lbnQpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIE1DUCBPQXV0aCBBdXRob3JpemVyIExhbWJkYVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBjb25zdCBhdXRob3JpemVyRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiQXV0aG9yaXplckhhbmRsZXJcIiwge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCBcImF1dGhvcml6ZXJcIikpLFxuICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgT0FVVEhfU0VSVkVSX1VSTDogb2F1dGhTZXJ2ZXJVcmwsXG4gICAgICAgIEJPVU5EX09SR19JRDogb3JnYW5pemF0aW9uSWQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgaHR0cEF1dGhvcml6ZXIgPSBuZXcgYXV0aG9yaXplcnMuSHR0cExhbWJkYUF1dGhvcml6ZXIoXG4gICAgICBcIkhlcmV5YUF1dGhvcml6ZXJcIixcbiAgICAgIGF1dGhvcml6ZXJGbixcbiAgICAgIHtcbiAgICAgICAgcmVzcG9uc2VUeXBlczogW2F1dGhvcml6ZXJzLkh0dHBMYW1iZGFSZXNwb25zZVR5cGUuU0lNUExFXSxcbiAgICAgICAgcmVzdWx0c0NhY2hlVHRsOiBjZGsuRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBIVFRQIEFQSVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICBjb25zdCBodHRwQXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkh0dHBBcGlcIiwge1xuICAgICAgYXBpTmFtZTogdGhpcy5zdGFja05hbWUsXG4gICAgfSk7XG5cbiAgICBjb25zdCBsYW1iZGFJbnRlZ3JhdGlvbiA9IG5ldyBpbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgXCJMYW1iZGFJbnRlZ3JhdGlvblwiLFxuICAgICAgZm5cbiAgICApO1xuXG4gICAgLy8gQ29tcHV0ZSBzZXJ2aWNlIFVSTCBmb3IgUFJNIChjdXN0b20gZG9tYWluIG9yIEFQSSBlbmRwb2ludClcbiAgICBjb25zdCBzZXJ2aWNlVXJsID0gY3VzdG9tRG9tYWluXG4gICAgICA/IGBodHRwczovLyR7Y3VzdG9tRG9tYWlufWBcbiAgICAgIDogaHR0cEFwaS5hcGlFbmRwb2ludDtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gUHJvdGVjdGVkIFJlc291cmNlIE1ldGFkYXRhIChSRkMgOTcyOClcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgY29uc3QgcHJtTGFtYmRhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIlBybUhhbmRsZXJcIiwge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoYFxuICAgICAgICBleHBvcnRzLmhhbmRsZXIgPSBhc3luYyAoKSA9PiAoe1xuICAgICAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgICAgICAgICAgIFwiQ2FjaGUtQ29udHJvbFwiOiBcInB1YmxpYywgbWF4LWFnZT0zNjAwXCIsXG4gICAgICAgICAgICBcIkFjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpblwiOiBcIipcIixcbiAgICAgICAgICB9LFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgIHJlc291cmNlOiBwcm9jZXNzLmVudi5TRVJWSUNFX1VSTCArIFwiL21jcFwiLFxuICAgICAgICAgICAgYXV0aG9yaXphdGlvbl9zZXJ2ZXJzOiBbcHJvY2Vzcy5lbnYuT0FVVEhfU0VSVkVSX1VSTCArIFwiL29hdXRoL1wiICsgcHJvY2Vzcy5lbnYuT1JHQU5JWkFUSU9OX0lEXSxcbiAgICAgICAgICAgIGJlYXJlcl9tZXRob2RzX3N1cHBvcnRlZDogW1wiaGVhZGVyXCJdLFxuICAgICAgICAgICAgc2NvcGVzX3N1cHBvcnRlZDogW1wibWNwOmFjY2Vzc1wiXSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSk7XG4gICAgICBgKSxcbiAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgU0VSVklDRV9VUkw6IHNlcnZpY2VVcmwsXG4gICAgICAgIE9BVVRIX1NFUlZFUl9VUkw6IG9hdXRoU2VydmVyVXJsLFxuICAgICAgICBPUkdBTklaQVRJT05fSUQ6IG9yZ2FuaXphdGlvbklkLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGh0dHBBcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiLy53ZWxsLWtub3duL29hdXRoLXByb3RlY3RlZC1yZXNvdXJjZVwiLFxuICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgaW50ZWdyYXRpb246IG5ldyBpbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBcIlBybUludGVncmF0aW9uXCIsXG4gICAgICAgIHBybUxhbWJkYVxuICAgICAgKSxcbiAgICB9KTtcblxuICAgIC8vIE1DUCByb3V0ZSAoZXhpc3RpbmcpXG4gICAgaHR0cEFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogXCIvbWNwXCIsXG4gICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1RdLFxuICAgICAgaW50ZWdyYXRpb246IGxhbWJkYUludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogaHR0cEF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIEZyb250ZW5kIEF1dGhvcml6ZXIgTGFtYmRhIChDb2duaXRvIEpXVCBjb29raWUgdmFsaWRhdGlvbilcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgbGV0IGZyb250ZW5kQXV0aG9yaXplcjogYXV0aG9yaXplcnMuSHR0cExhbWJkYUF1dGhvcml6ZXIgfCB1bmRlZmluZWQ7XG5cbiAgICBpZiAoY29nbml0b1VzZXJQb29sSWQgJiYgY29nbml0b0NsaWVudElkKSB7XG4gICAgICBjb25zdCBmcm9udGVuZEF1dGhvcml6ZXJGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24oXG4gICAgICAgIHRoaXMsXG4gICAgICAgIFwiRnJvbnRlbmRBdXRob3JpemVySGFuZGxlclwiLFxuICAgICAgICB7XG4gICAgICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KFxuICAgICAgICAgICAgcGF0aC5qb2luKF9fZGlybmFtZSwgXCJmcm9udGVuZC1hdXRob3JpemVyXCIpXG4gICAgICAgICAgKSxcbiAgICAgICAgICBtZW1vcnlTaXplOiAxMjgsXG4gICAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgICAgICBDT0dOSVRPX1VTRVJfUE9PTF9JRDogY29nbml0b1VzZXJQb29sSWQsXG4gICAgICAgICAgICBDT0dOSVRPX1JFR0lPTjogY29nbml0b1JlZ2lvbixcbiAgICAgICAgICB9LFxuICAgICAgICB9XG4gICAgICApO1xuXG4gICAgICBmcm9udGVuZEF1dGhvcml6ZXIgPSBuZXcgYXV0aG9yaXplcnMuSHR0cExhbWJkYUF1dGhvcml6ZXIoXG4gICAgICAgIFwiRnJvbnRlbmRBdXRob3JpemVyXCIsXG4gICAgICAgIGZyb250ZW5kQXV0aG9yaXplckZuLFxuICAgICAgICB7XG4gICAgICAgICAgcmVzcG9uc2VUeXBlczogW2F1dGhvcml6ZXJzLkh0dHBMYW1iZGFSZXNwb25zZVR5cGUuU0lNUExFXSxcbiAgICAgICAgICByZXN1bHRzQ2FjaGVUdGw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDApLCAvLyBObyBjYWNoaW5nIOKAlCBjb29raWUtYmFzZWRcbiAgICAgICAgICBpZGVudGl0eVNvdXJjZTogW10sIC8vIE5vIGlkZW50aXR5IHNvdXJjZSDigJQgYWx3YXlzIGludm9rZSBhdXRob3JpemVyIChzdXBwb3J0cyBwdWJsaWMgZW5kcG9pbnRzIHdpdGhvdXQgY29va2llcylcbiAgICAgICAgfVxuICAgICAgKTtcblxuICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgLy8gQXV0aCBMYW1iZGEgKGxvZ2luL09UUC92ZXJpZnkvbG9nb3V0KVxuICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgICBjb25zdCBhdXRoTGFtYmRhRW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgICBDT0dOSVRPX1VTRVJfUE9PTF9JRDogY29nbml0b1VzZXJQb29sSWQsXG4gICAgICAgIENPR05JVE9fQ0xJRU5UX0lEOiBjb2duaXRvQ2xpZW50SWQsXG4gICAgICAgIENPR05JVE9fUkVHSU9OOiBjb2duaXRvUmVnaW9uLFxuICAgICAgICBDVVNUT01fRE9NQUlOOiBjdXN0b21Eb21haW4gPz8gXCJcIixcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IGF1dGhMYW1iZGFGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJBdXRoTGFtYmRhSGFuZGxlclwiLCB7XG4gICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YLFxuICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsIFwiYXV0aC1sYW1iZGFcIikpLFxuICAgICAgICBtZW1vcnlTaXplOiAxMjgsXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDE1KSxcbiAgICAgICAgZW52aXJvbm1lbnQ6IGF1dGhMYW1iZGFFbnYsXG4gICAgICB9KTtcblxuICAgICAgLy8gR3JhbnQgQXV0aCBMYW1iZGEgYWNjZXNzIHRvIGFsbCBzZWNyZXRzIGZyb20gaGVyZXlhUHJvamVjdEVudlxuICAgICAgLy8gKHNhbWUgc2VjcmV0cyBhbHJlYWR5IGNyZWF0ZWQgZm9yIHRoZSBtYWluIGhhbmRsZXIg4oCUIHJldXNlIHRoZW0pXG4gICAgICBjb25zdCBhdXRoU2VjcmV0S2V5czogc3RyaW5nW10gPSBbXTtcbiAgICAgIGZvciAoY29uc3QgeyBrZXksIHNlY3JldCwgc2VjcmV0TmFtZSB9IG9mIHNlY3JldEVudkVudHJpZXMpIHtcbiAgICAgICAgYXV0aExhbWJkYUZuLmFkZEVudmlyb25tZW50KGtleSwgc2VjcmV0TmFtZSk7XG4gICAgICAgIHNlY3JldC5ncmFudFJlYWQoYXV0aExhbWJkYUZuKTtcbiAgICAgICAgYXV0aFNlY3JldEtleXMucHVzaChrZXkpO1xuICAgICAgfVxuICAgICAgaWYgKGF1dGhTZWNyZXRLZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgYXV0aExhbWJkYUZuLmFkZEVudmlyb25tZW50KFwiU0VDUkVUX0tFWVNcIiwgYXV0aFNlY3JldEtleXMuam9pbihcIixcIikpO1xuICAgICAgfVxuXG4gICAgICAvLyBHcmFudCBBdXRoIExhbWJkYSBDb2duaXRvIHBlcm1pc3Npb25zIChzYW1lIElBTSBwb2xpY2llcyBhcyBtYWluIGhhbmRsZXIpXG4gICAgICBmb3IgKGNvbnN0IFssIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwb2xpY3lFbnYpKSB7XG4gICAgICAgIGNvbnN0IHBvbGljeSA9IEpTT04ucGFyc2UodmFsdWUgYXMgc3RyaW5nKTtcbiAgICAgICAgZm9yIChjb25zdCBzdGF0ZW1lbnQgb2YgcG9saWN5LlN0YXRlbWVudCkge1xuICAgICAgICAgIGF1dGhMYW1iZGFGbi5hZGRUb1JvbGVQb2xpY3koaWFtLlBvbGljeVN0YXRlbWVudC5mcm9tSnNvbihzdGF0ZW1lbnQpKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCBhdXRoTGFtYmRhSW50ZWdyYXRpb24gPSBuZXcgaW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICAgXCJBdXRoTGFtYmRhSW50ZWdyYXRpb25cIixcbiAgICAgICAgYXV0aExhbWJkYUZuXG4gICAgICApO1xuXG4gICAgICAvLyBBdXRoIHJvdXRlcyAobm8gYXV0aG9yaXplciDigJQgYWx3YXlzIGFjY2Vzc2libGUpXG4gICAgICBodHRwQXBpLmFkZFJvdXRlcyh7XG4gICAgICAgIHBhdGg6IFwiL3thcHB9L2F1dGgve3Byb3h5K31cIixcbiAgICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGFwaWd3djIuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgICAgaW50ZWdyYXRpb246IGF1dGhMYW1iZGFJbnRlZ3JhdGlvbixcbiAgICAgIH0pO1xuXG4gICAgICAvLyBGcm9udGVuZCByb3V0ZXMgKHdpdGggRnJvbnRlbmQgQXV0aG9yaXplciDihpIgT3JnIExhbWJkYSlcbiAgICAgIGNvbnN0IGZyb250ZW5kUm91dGVQYXR0ZXJucyA9IFtcbiAgICAgICAgXCIve2FwcH0vdmlldy97cHJveHkrfVwiLFxuICAgICAgICBcIi97YXBwfS9kYXRhL3twcm94eSt9XCIsXG4gICAgICAgIFwiL3thcHB9L2FjdGlvbi97cHJveHkrfVwiLFxuICAgICAgICBcIi97YXBwfS9mb3JtL3twcm94eSt9XCIsXG4gICAgICBdO1xuXG4gICAgICBmb3IgKGNvbnN0IHJvdXRlUGF0aCBvZiBmcm9udGVuZFJvdXRlUGF0dGVybnMpIHtcbiAgICAgICAgaHR0cEFwaS5hZGRSb3V0ZXMoe1xuICAgICAgICAgIHBhdGg6IHJvdXRlUGF0aCxcbiAgICAgICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1RdLFxuICAgICAgICAgIGludGVncmF0aW9uOiBsYW1iZGFJbnRlZ3JhdGlvbixcbiAgICAgICAgICBhdXRob3JpemVyOiBmcm9udGVuZEF1dGhvcml6ZXIsXG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRjaC1hbGwgZm9yIHVubWF0Y2hlZCBmcm9udGVuZCBwYXRocyAoZS5nLiwgL3thcHB9LyByb290KVxuICAgICAgLy8gTW9yZSBzcGVjaWZpYyByb3V0ZXMgYWJvdmUgdGFrZSBwcmlvcml0eSBpbiBBUEkgR2F0ZXdheSBIVFRQIEFQSVxuICAgICAgaHR0cEFwaS5hZGRSb3V0ZXMoe1xuICAgICAgICBwYXRoOiBcIi97cHJveHkrfVwiLFxuICAgICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICAgIGludGVncmF0aW9uOiBsYW1iZGFJbnRlZ3JhdGlvbixcbiAgICAgICAgYXV0aG9yaXplcjogZnJvbnRlbmRBdXRob3JpemVyLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBDdXN0b20gZG9tYWluICsgRE5TXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIGlmIChjdXN0b21Eb21haW4gJiYgY3VzdG9tRG9tYWluWm9uZSkge1xuICAgICAgaWYgKCF3aWxkY2FyZENlcnRpZmljYXRlQXJuKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIndpbGRjYXJkQ2VydGlmaWNhdGVBcm4gaXMgcmVxdWlyZWQgd2hlbiBjdXN0b21Eb21haW4gaXMgc2V0XCJcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgY2VydGlmaWNhdGUgPSBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKFxuICAgICAgICB0aGlzLFxuICAgICAgICBcIkNlcnRpZmljYXRlXCIsXG4gICAgICAgIHdpbGRjYXJkQ2VydGlmaWNhdGVBcm5cbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IGhvc3RlZFpvbmUgPSByb3V0ZTUzLkhvc3RlZFpvbmUuZnJvbUxvb2t1cCh0aGlzLCBcIkhvc3RlZFpvbmVcIiwge1xuICAgICAgICBkb21haW5OYW1lOiBjdXN0b21Eb21haW5ab25lLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEFQSSBHYXRld2F5IGN1c3RvbSBkb21haW4gZm9yIE1DUCAoZXhhY3QgZG9tYWluKVxuICAgICAgY29uc3QgZG9tYWluTmFtZSA9IG5ldyBhcGlnd3YyLkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgICAgZG9tYWluTmFtZTogY3VzdG9tRG9tYWluLFxuICAgICAgICBjZXJ0aWZpY2F0ZSxcbiAgICAgIH0pO1xuXG4gICAgICBuZXcgYXBpZ3d2Mi5BcGlNYXBwaW5nKHRoaXMsIFwiQXBpTWFwcGluZ1wiLCB7XG4gICAgICAgIGFwaTogaHR0cEFwaSxcbiAgICAgICAgZG9tYWluTmFtZSxcbiAgICAgIH0pO1xuXG4gICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiBjdXN0b21Eb21haW4sXG4gICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKFxuICAgICAgICAgIG5ldyB0YXJnZXRzLkFwaUdhdGV3YXl2MkRvbWFpblByb3BlcnRpZXMoXG4gICAgICAgICAgICBkb21haW5OYW1lLnJlZ2lvbmFsRG9tYWluTmFtZSxcbiAgICAgICAgICAgIGRvbWFpbk5hbWUucmVnaW9uYWxIb3N0ZWRab25lSWRcbiAgICAgICAgICApXG4gICAgICAgICksXG4gICAgICB9KTtcblxuICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgLy8gQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gZm9yIGZyb250ZW5kICgqLntjdXN0b21Eb21haW59KVxuICAgICAgLy8gQ2xvdWRGcm9udCBSRVFVSVJFUyBBQ00gY2VydGlmaWNhdGVzIGluIHVzLWVhc3QtMSwgcmVnYXJkbGVzcyBvZlxuICAgICAgLy8gd2hpY2ggcmVnaW9uIHRoaXMgc3RhY2sgaXMgZGVwbG95ZWQgdG8uIFdlIGF1dG8tY3JlYXRlIG9uZSB2aWFcbiAgICAgIC8vIERuc1ZhbGlkYXRlZENlcnRpZmljYXRlIHdoaWNoIHByb3Zpc2lvbnMgaXQgaW4gdXMtZWFzdC0xIHdpdGhcbiAgICAgIC8vIEROUyB2YWxpZGF0aW9uIHRocm91Z2ggdGhlIHNhbWUgaG9zdGVkIHpvbmUuXG4gICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAgIGlmIChjb2duaXRvVXNlclBvb2xJZCAmJiBjb2duaXRvQ2xpZW50SWQpIHtcbiAgICAgICAgY29uc3QgY2xvdWRmcm9udENlcnRpZmljYXRlID0gbmV3IGFjbS5EbnNWYWxpZGF0ZWRDZXJ0aWZpY2F0ZShcbiAgICAgICAgICB0aGlzLFxuICAgICAgICAgIFwiQ2xvdWRGcm9udENlcnRpZmljYXRlXCIsXG4gICAgICAgICAge1xuICAgICAgICAgICAgZG9tYWluTmFtZTogYCouJHtjdXN0b21Eb21haW59YCxcbiAgICAgICAgICAgIGhvc3RlZFpvbmUsXG4gICAgICAgICAgICByZWdpb246IFwidXMtZWFzdC0xXCIsXG4gICAgICAgICAgfVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIENsb3VkRnJvbnQgRnVuY3Rpb246IGV4dHJhY3QgYXBwIHN1YmRvbWFpbiDihpIgcHJlcGVuZCB0byBwYXRoXG4gICAgICAgIGNvbnN0IGNmRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlN1YmRvbWFpblJld3JpdGVcIiwge1xuICAgICAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21JbmxpbmUoYFxuZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuICB2YXIgcmVxdWVzdCA9IGV2ZW50LnJlcXVlc3Q7XG4gIHZhciBob3N0ID0gcmVxdWVzdC5oZWFkZXJzLmhvc3QudmFsdWU7XG4gIHZhciBjdXN0b21Eb21haW4gPSAnJHtjdXN0b21Eb21haW59JztcbiAgaWYgKGhvc3QgIT09IGN1c3RvbURvbWFpbiAmJiBob3N0LmVuZHNXaXRoKCcuJyArIGN1c3RvbURvbWFpbikpIHtcbiAgICB2YXIgYXBwTmFtZSA9IGhvc3Quc2xpY2UoMCwgLShjdXN0b21Eb21haW4ubGVuZ3RoICsgMSkpO1xuICAgIHJlcXVlc3QudXJpID0gJy8nICsgYXBwTmFtZSArIHJlcXVlc3QudXJpO1xuICB9XG4gIHJldHVybiByZXF1ZXN0O1xufVxuICAgICAgICAgIGApLFxuICAgICAgICAgIGZ1bmN0aW9uTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LXN1YmRvbWFpbi1yZXdyaXRlYCxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQVBJIEdhdGV3YXkgb3JpZ2luXG4gICAgICAgIGNvbnN0IGFwaURvbWFpbk5hbWUgPSBjZGsuRm4uc2VsZWN0KFxuICAgICAgICAgIDIsXG4gICAgICAgICAgY2RrLkZuLnNwbGl0KFwiL1wiLCBodHRwQXBpLmFwaUVuZHBvaW50KVxuICAgICAgICApOyAvLyBleHRyYWN0IGRvbWFpbiBmcm9tIGh0dHBzOi8veHh4LmV4ZWN1dGUtYXBpLi4uXG5cbiAgICAgICAgY29uc3QgZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKFxuICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgXCJGcm9udGVuZERpc3RyaWJ1dGlvblwiLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGNlcnRpZmljYXRlOiBjbG91ZGZyb250Q2VydGlmaWNhdGUsXG4gICAgICAgICAgICBkb21haW5OYW1lczogW2AqLiR7Y3VzdG9tRG9tYWlufWBdLFxuICAgICAgICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XG4gICAgICAgICAgICAgIG9yaWdpbjogbmV3IG9yaWdpbnMuSHR0cE9yaWdpbihhcGlEb21haW5OYW1lLCB7XG4gICAgICAgICAgICAgICAgcHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUHJvdG9jb2xQb2xpY3kuSFRUUFNfT05MWSxcbiAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OlxuICAgICAgICAgICAgICAgIGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRCxcbiAgICAgICAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeShcbiAgICAgICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgICAgIFwiRnJvbnRlbmRPcmlnaW5Qb2xpY3lcIixcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBjb29raWVCZWhhdmlvcjpcbiAgICAgICAgICAgICAgICAgICAgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0Q29va2llQmVoYXZpb3IuYWxsb3dMaXN0KFxuICAgICAgICAgICAgICAgICAgICAgIFwiaGVyZXlhX2lkX3Rva2VuXCJcbiAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgIGhlYWRlckJlaGF2aW9yOlxuICAgICAgICAgICAgICAgICAgICBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5hbGxvd0xpc3QoXG4gICAgICAgICAgICAgICAgICAgICAgXCJDb250ZW50LVR5cGVcIlxuICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjpcbiAgICAgICAgICAgICAgICAgICAgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgZnVuY3Rpb246IGNmRnVuY3Rpb24sXG4gICAgICAgICAgICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25FdmVudFR5cGUuVklFV0VSX1JFUVVFU1QsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIFJvdXRlNTMgd2lsZGNhcmQg4oaSIENsb3VkRnJvbnRcbiAgICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIldpbGRjYXJkQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICAgIHpvbmU6IGhvc3RlZFpvbmUsXG4gICAgICAgICAgcmVjb3JkTmFtZTogYCouJHtjdXN0b21Eb21haW59YCxcbiAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhcbiAgICAgICAgICAgIG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQoZGlzdHJpYnV0aW9uKVxuICAgICAgICAgICksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiRnJvbnRlbmREaXN0cmlidXRpb25Eb21haW5cIiwge1xuICAgICAgICAgIHZhbHVlOiBkaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uRG9tYWluTmFtZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiU2VydmljZVVybFwiLCB7XG4gICAgICAgIHZhbHVlOiBgaHR0cHM6Ly8ke2N1c3RvbURvbWFpbn1gLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiU2VydmljZVVybFwiLCB7XG4gICAgICAgIHZhbHVlOiBodHRwQXBpLmFwaUVuZHBvaW50LFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3REb21haW5ab25lKFxuICBjdXN0b21Eb21haW46IHN0cmluZyB8IHVuZGVmaW5lZFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFjdXN0b21Eb21haW4pIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHBhcnRzID0gY3VzdG9tRG9tYWluLnNwbGl0KFwiLlwiKTtcbiAgaWYgKHBhcnRzLmxlbmd0aCA8IDIpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgZG9tYWluIG5hbWU6IFwiICsgY3VzdG9tRG9tYWluKTtcbiAgcmV0dXJuIHBhcnRzLmxlbmd0aCA9PT0gMiA/IGN1c3RvbURvbWFpbiA6IHBhcnRzLnNsaWNlKDEpLmpvaW4oXCIuXCIpO1xufVxuIl19