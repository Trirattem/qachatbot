import fs from 'fs';
import path from 'path';
import axios from 'axios';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import driveUploader from './driveUploader.js';
import DocsClient from './docsClient.js';
import SheetsClient from './sheetsClient.js';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

class ImageSyncTool {
  constructor(topic = '') {
    this.localDirs = [
      path.resolve(config.paths.screenshots, 'fail', topic),
      path.resolve(config.paths.screenshots, 'partial', topic),
      path.resolve(config.paths.screenshots, 'pass', topic),
    ];
  }

  extractTestCaseId(filename) {
    const nameNoExt = path.parse(filename).name;
    const parts = nameNoExt.split('_');
    const idParts = [];
    for (const part of parts) {
      if (part.toLowerCase().startsWith('attempt')) break;
      if (/^\d+$/.test(part) && part.length >= 6) break; // likely a timestamp
      idParts.push(part);
    }
    return idParts.length > 0 ? idParts.join('_') : nameNoExt;
  }

  scanLocalImages() {
    const imageMap = {};
    let totalFiles = 0;

    for (const localDir of this.localDirs) {
      if (!fs.existsSync(localDir)) {
        logger.info(`   ⚠️ ข้ามโฟลเดอร์ (ไม่มีอยู่จริง): ${localDir}`);
        continue;
      }
      
      const files = fs.readdirSync(localDir)
        .filter(f => IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase()));
      
      logger.info(`   📂 สแกนโฟลเดอร์: ${localDir} (พบ ${files.length} รูป)`);

      for (const filename of files) {
        const tcId = this.extractTestCaseId(filename);
        const fullPath = path.join(localDir, filename);
        if (!imageMap[tcId]) imageMap[tcId] = [];
        
        imageMap[tcId].push({
          name: filename,
          path: fullPath,
          folder: path.basename(localDir),
        });
        totalFiles++;
      }
    }
    
    return { imageMap, totalFiles };
  }

  async uploadToImgBB(imagePath) {
    if (!config.system.imgbbApiKey) {
      throw new Error('IMGBB_API_KEY is missing in .env');
    }
    const imageData = fs.readFileSync(imagePath, { encoding: 'base64' });
    const formData = new URLSearchParams();
    formData.append('key', config.system.imgbbApiKey);
    formData.append('image', imageData);
    formData.append('name', path.basename(imagePath));

    const response = await axios.post('https://api.imgbb.com/1/upload', formData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 60000,
    });

    if (response.status === 200 && response.data.success) {
      return response.data.data.url;
    }
    throw new Error(`imgbb error: ${response.status} — ${JSON.stringify(response.data)}`);
  }

  async uploadToDrive(imagePath) {
    if (!config.system.driveFolderId && !config.google.driveScreenshotFolderId) {
       throw new Error('GOOGLE_DRIVE_SCREENSHOT_FOLDER_ID is missing');
    }
    driveUploader.setFolder(config.system.driveFolderId || config.google.driveScreenshotFolderId);
    const result = await driveUploader.uploadScreenshot(imagePath, path.basename(imagePath));
    return result.webContentLink; // URL that can be viewed/inserted
  }

  async run(targetType, uploadMethod = 'drive') {
    logger.info('============================================================');
    logger.info(`📂 Image Sync Tool — Uploading to ${uploadMethod.toUpperCase()} & Syncing to ${targetType.toUpperCase()}`);
    logger.info('============================================================');

    const { imageMap, totalFiles } = this.scanLocalImages();
    if (totalFiles === 0) {
      logger.warn('⚠️ ไม่พบรูปภาพในโฟลเดอร์ screenshots เลย — หยุดการทำงาน');
      return;
    }

    logger.info(`✅ พบภาพทั้งหมด ${totalFiles} รูป จับคู่ได้ ${Object.keys(imageMap).length} กลุ่ม (Test Cases)`);

    // Upload phase
    const urlMap = {};
    for (const tcId of Object.keys(imageMap)) {
      urlMap[tcId] = [];
      for (const img of imageMap[tcId]) {
        logger.info(`📤 Uploading [${img.folder}] ${img.name}...`);
        try {
          let url;
          if (uploadMethod === 'imgbb') {
            url = await this.uploadToImgBB(img.path);
          } else {
            url = await this.uploadToDrive(img.path);
          }
          urlMap[tcId].push({ name: img.name, url });
          logger.info(`      ☁️  สำเร็จ -> ${url}`);
        } catch (err) {
          logger.error(`      ❌ ล้มเหลว: ${err.message}`);
        }
      }
    }

    // Sync phase
    if (targetType === 'docs') {
      const client = new DocsClient();
      await client.init();
      // use the new bulk sync method
      await client.syncImagesToDocs(urlMap);
    } else if (targetType === 'sheets') {
      const client = new SheetsClient();
      await client.init();
      await client.syncImagesToSheets(urlMap);
    }
  }
}

export default ImageSyncTool;
