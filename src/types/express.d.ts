declare namespace Express {
  interface Request {
    authenticatedUserId?: string;
    authToken?: string;
  }
}
