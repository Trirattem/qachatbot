import fs from 'fs';
import { google } from 'googleapis';
import logger from '../utils/logger.js';
import config from '../config/index.js';

class DriveUploader {
  constructor() {
    this.drive = null;
    this.folderId = null; // Target folder ID in drive
  }

  async init() {
    logger.info('Authenticating with Google Drive API...');
    const auth = new google.auth.GoogleAuth({
      keyFile: config.google.keyFilePath,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });

    const client = await auth.getClient();
    this.drive = google.drive({ version: 'v3', auth: client });
    logger.info('Google Drive API ready');
  }

  async setFolder(folderId) {
    this.folderId = folderId;
  }

  async uploadScreenshot(filePath, fileName) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    try {
      const fileMetadata = {
        name: fileName,
        parents: this.folderId ? [this.folderId] : undefined,
      };

      const media = {
        mimeType: 'image/jpeg',
        body: fs.createReadStream(filePath),
      };

      const response = await this.drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id, webViewLink, webContentLink',
      });

      // Optional: Make it publicly readable so Docs can embed it via URL
      await this.drive.permissions.create({
        fileId: response.data.id,
        requestBody: {
          role: 'reader',
          type: 'anyone',
        },
      });

      logger.debug(`Uploaded screenshot to Drive: ${response.data.id}`);
      return {
        id: response.data.id,
        webViewLink: response.data.webViewLink,
        webContentLink: response.data.webContentLink, // Use this for embedding
      };
    } catch (err) {
      logger.error('Failed to upload screenshot to Drive', { error: err.message });
      return null;
    }
  }

  async cleanOldFiles(days) {
    if (!this.folderId) return;

    try {
      const timeThreshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const q = `'${this.folderId}' in parents and modifiedTime < '${timeThreshold}' and trashed = false`;

      const response = await this.drive.files.list({
        q,
        fields: 'files(id, name)',
      });

      const files = response.data.files || [];
      for (const file of files) {
        await this.drive.files.delete({ fileId: file.id });
        logger.debug(`Deleted old file from Drive: ${file.name}`);
      }
      logger.info(`Cleaned ${files.length} old screenshots from Drive`);
    } catch (err) {
      logger.warn('Failed to clean old files from Drive', { error: err.message });
    }
  }
}

export default new DriveUploader();
