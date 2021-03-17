const jwt = require('express-jwt');
const jwksRsa = require('jwks-rsa');
require("dotenv").config();

// Auth0 configuration
const authenticated = jwt({
    secret: jwksRsa.expressJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 40,
        jwksUri: process.env.AUTH0_JWKSURI
  }),
  audience: process.env.AUTH0_AUDIENCE,
  issuer: process.env.AUTH0_ISSUER,
  algorithms: ['RS256']
});

module.exports = { authenticated };