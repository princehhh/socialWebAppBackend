import { env } from "../config/env";

const baseServerUrl = `http://localhost:${env.PORT}`;

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "SocialVoice Backend API",
    version: "1.0.0",
    description: "OpenAPI documentation for SocialVoice backend endpoints."
  },
  servers: [
    {
      url: `${baseServerUrl}/api/v1`,
      description: "Local backend"
    }
  ],
  tags: [
    { name: "Health" },
    { name: "Config" },
    { name: "Auth" },
    { name: "Users" },
    { name: "Wallet" },
    { name: "Calls" },
    { name: "Safety" },
    { name: "Profile" },
    { name: "Account" }
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT"
      }
    },
    schemas: {
      ApiEnvelope: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          message: { type: "string" },
          data: { type: "object", nullable: true },
          errorCode: { type: "string", nullable: true }
        }
      },
      MobileLoginRequest: {
        type: "object",
        required: ["mobileNumber"],
        properties: {
          mobileNumber: { type: "string", example: "+911234567890" }
        }
      },
      MobileSignupRequest: {
        type: "object",
        required: ["mobileNumber", "name"],
        properties: {
          mobileNumber: { type: "string", example: "+911234567890" },
          name: { type: "string", example: "Jonny" },
          referralCode: { type: "string", example: "ABC123" },
          preferredLanguage: { type: "string", example: "en" }
        }
      },
      AnonymousLoginRequest: {
        type: "object",
        properties: {
          preferredLanguage: { type: "string", example: "en" }
        }
      },
      UserStatusRequest: {
        type: "object",
        required: ["status"],
        properties: {
          status: {
            type: "string",
            enum: ["ONLINE", "OFFLINE", "BUSY"]
          }
        }
      },
      WalletTopupRequest: {
        type: "object",
        required: ["amountCoins"],
        properties: {
          amountCoins: { type: "integer", example: 100 }
        }
      },
      CallRequestPayload: {
        type: "object",
        properties: {
          receiverUserId: { type: "string", example: "uuid-of-user" },
          receiverAnonymousId: { type: "string", example: "SV123456" }
        },
        description: "Provide receiverUserId (preferred) or receiverAnonymousId."
      },
      CallCompletePayload: {
        type: "object",
        required: ["callId", "durationSeconds", "status"],
        properties: {
          callId: { type: "string" },
          durationSeconds: { type: "integer", example: 60 },
          status: { type: "string", enum: ["COMPLETED", "FAILED"] },
          failureReason: { type: "string" }
        }
      },
      ReportPayload: {
        type: "object",
        required: ["reportedAnonymousId", "reason"],
        properties: {
          reportedAnonymousId: { type: "string", example: "SV654321" },
          reason: { type: "string", example: "Abusive language" }
        }
      },
      BlockPayload: {
        type: "object",
        required: ["blockedAnonymousId"],
        properties: {
          blockedAnonymousId: { type: "string", example: "SV654321" }
        }
      },
      ProfilePayload: {
        type: "object",
        properties: {
          preferredLanguage: { type: "string", example: "hi" }
        }
      }
    }
  },
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Health check"
      }
    },
    "/config/public": {
      get: {
        tags: ["Config"],
        summary: "Get public app configuration"
      }
    },
    "/content/legal": {
      get: {
        tags: ["Config"],
        summary: "Get legal content"
      }
    },
    "/auth/mobile-login": {
      post: {
        tags: ["Auth"],
        summary: "Login with mobile number",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/MobileLoginRequest" }
            }
          }
        }
      }
    },
    "/auth/mobile-signup": {
      post: {
        tags: ["Auth"],
        summary: "Signup with mobile number",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/MobileSignupRequest" }
            }
          }
        }
      }
    },
    "/auth/anonymous-login": {
      post: {
        tags: ["Auth"],
        summary: "Anonymous login",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AnonymousLoginRequest" }
            }
          }
        }
      }
    },
    "/users/available": {
      get: {
        tags: ["Users"],
        summary: "Get available users",
        security: [{ bearerAuth: [] }]
      }
    },
    "/users/status": {
      patch: {
        tags: ["Users"],
        summary: "Update current user status",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UserStatusRequest" }
            }
          }
        }
      }
    },
    "/wallet": {
      get: {
        tags: ["Wallet"],
        summary: "Get wallet summary",
        security: [{ bearerAuth: [] }]
      }
    },
    "/wallet/transactions": {
      get: {
        tags: ["Wallet"],
        summary: "Get wallet transactions",
        security: [{ bearerAuth: [] }]
      }
    },
    "/wallet/mock-topup": {
      post: {
        tags: ["Wallet"],
        summary: "Mock topup",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WalletTopupRequest" }
            }
          }
        }
      }
    },
    "/calls/request": {
      post: {
        tags: ["Calls"],
        summary: "Request call session",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CallRequestPayload" }
            }
          }
        }
      }
    },
    "/calls/complete": {
      post: {
        tags: ["Calls"],
        summary: "Complete or fail call",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CallCompletePayload" }
            }
          }
        }
      }
    },
    "/calls/recent": {
      get: {
        tags: ["Calls"],
        summary: "Get recent calls",
        security: [{ bearerAuth: [] }]
      }
    },
    "/reports": {
      post: {
        tags: ["Safety"],
        summary: "Report a user",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ReportPayload" }
            }
          }
        }
      }
    },
    "/blocks": {
      post: {
        tags: ["Safety"],
        summary: "Block a user",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BlockPayload" }
            }
          }
        }
      }
    },
    "/profile": {
      patch: {
        tags: ["Profile"],
        summary: "Update profile",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProfilePayload" }
            }
          }
        }
      }
    },
    "/logout": {
      post: {
        tags: ["Account"],
        summary: "Logout current user",
        security: [{ bearerAuth: [] }]
      }
    },
    "/account": {
      delete: {
        tags: ["Account"],
        summary: "Delete account",
        security: [{ bearerAuth: [] }]
      }
    }
  }
} as const;
