/**
 * src/utils/googleAuth.js
 * OAuth 2.0 authentication helper for Google APIs
 * Handles token refresh and browser login flow
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import http from 'http';
import url from 'url';
import logger from './logger.js';

class GoogleAuthHandler {
  constructor(credentialsPath, tokenPath) {
    this.credentialsPath = credentialsPath;
    this.tokenPath = tokenPath;
    this.oauth2Client = null;
    this.clientId = null;
    this.clientSecret = null;
  }

  /**
   * Initialize OAuth2 client and get authenticated client
   */
  async getAuthenticatedClient() {
    const credentialsData = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
    
    // Support both Desktop (installed) and Web application formats
    const credentials = credentialsData.installed || credentialsData.web;
    
    if (!credentials) {
      throw new Error('Invalid OAuth credentials file: missing "installed" or "web" key');
    }
    
    const { client_id, client_secret } = credentials;
    
    // Store for later use in URL construction
    this.clientId = client_id;
    this.clientSecret = client_secret;
    
    // Use consistent redirect_uri for localhost testing
    const redirectUri = 'http://localhost:3000/';

    this.oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirectUri
    );

    // Try to load saved token
    if (fs.existsSync(this.tokenPath)) {
      try {
        const token = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
        this.oauth2Client.setCredentials(token);
        
        // Check if token is expired and refresh if needed
        if (this.oauth2Client.isTokenExpiring()) {
          logger.debug('Token expiring, refreshing...');
          const { credentials: newCredentials } = await this.oauth2Client.refreshAccessToken();
          this.oauth2Client.setCredentials(newCredentials);
          this._saveToken(newCredentials);
        }
        
        logger.info('Loaded existing OAuth token');
        return this.oauth2Client;
      } catch (err) {
        logger.warn('Could not load saved token, will perform new login', { error: err.message });
      }
    }

    // No token exists, perform new login
    logger.info('No OAuth token found, performing browser login...');
    await this._performNewLogin();
    return this.oauth2Client;
  }

  /**
   * Perform OAuth2 browser login flow
   */
  async _performNewLogin() {
    // Manually construct OAuth URL with all required parameters
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: 'http://localhost:3000/',
      response_type: 'code',
      scope: [
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive.file',
      ].join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    logger.info('═══════════════════════════════════════════════════');
    logger.info('🔐 AUTHORIZATION REQUIRED');
    logger.info('═══════════════════════════════════════════════════');
    logger.info('Please open this URL in your browser:');
    logger.info('');
    logger.info(authUrl);
    logger.info('');
    logger.info('After authorizing, you will be redirected to localhost.');
    logger.info('═══════════════════════════════════════════════════');

    // Try to open browser if possible
    try {
      const { spawn } = await import('child_process');
      const isWindows = process.platform === 'win32';
      const isMac = process.platform === 'darwin';
      const isLinux = process.platform === 'linux';

      if (isWindows) {
        spawn('cmd', ['/c', 'start', authUrl]);
      } else if (isMac) {
        spawn('open', [authUrl]);
      } else if (isLinux) {
        spawn('xdg-open', [authUrl]);
      }
      logger.info('✓ Browser opened automatically');
    } catch (err) {
      logger.debug('Could not open browser automatically');
    }

    // Start local server to capture redirect
    const authCode = await this._waitForAuthCode();
    
    // Exchange code for token
    const { tokens } = await this.oauth2Client.getToken(authCode);
    this.oauth2Client.setCredentials(tokens);
    this._saveToken(tokens);

    logger.info('✓ OAuth authentication successful!');
  }

  /**
   * Start local HTTP server to capture OAuth redirect
   */
  _waitForAuthCode() {
    return new Promise((resolve, reject) => {
      let server = null;
      let port = 3000;

      const startServer = () => {
        server = http.createServer((req, res) => {
          const parsedUrl = url.parse(req.url, true);
          const code = parsedUrl.query.code;

          if (code) {
            res.end('✓ Authorization successful! You can close this window.');
            server.close();
            resolve(code);
          } else {
            const error = parsedUrl.query.error;
            res.end('✗ Authorization failed!');
            server.close();
            reject(new Error(`OAuth error: ${error}`));
          }
        });

        server.listen(port, 'localhost', () => {
          logger.info(`✓ Listening for OAuth callback on http://localhost:${port}`);
        });

        server.on('error', (err) => {
          if (err.code === 'EADDRINUSE' && port === 80) {
            // If port 80 is in use, try port 3000
            port = 3000;
            logger.debug('Port 80 unavailable, trying port 3000');
            startServer();
          } else if (err.code === 'EADDRINUSE' && port === 3000) {
            reject(new Error('Could not start OAuth callback server (ports 80 and 3000 are in use)'));
          } else if (err.code === 'EACCES') {
            // Port 80 requires admin rights, try port 3000
            port = 3000;
            logger.debug('Port 80 requires admin rights, trying port 3000');
            startServer();
          } else {
            reject(err);
          }
        });
      };

      startServer();
    });
  }

  /**
   * Save token to file
   */
  _saveToken(token) {
    fs.writeFileSync(this.tokenPath, JSON.stringify(token, null, 2));
    logger.debug('OAuth token saved');
  }
}

export default GoogleAuthHandler;
