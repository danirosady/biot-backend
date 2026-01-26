import axios from 'axios';
import fs from 'fs/promises';
import FormData from 'form-data';
import path from 'path';

export interface OtaConfig {
  binPath: string;
  deviceId: string;
  version: string;
  title?: string;
  description?: string;
  tbServer: string;
  tbToken: string; // Tenant admin token
}

export interface OtaResult {
  success: boolean;
  packageId?: string;
  error?: string;
}

/**
 * ThingsBoard OTA firmware uploader
 */
export class OtaUploader {
  private tbBaseUrl: string;

  constructor(tbBaseUrl?: string) {
    this.tbBaseUrl = (tbBaseUrl || process.env.THINGSBOARD_BASE_URL || 'http://103.103.20.119:8080')
      .replace(/\/+$/, '');
  }

  /**
   * Upload firmware to ThingsBoard and trigger OTA update
   */
  async uploadAndDeploy(config: OtaConfig): Promise<OtaResult> {
    try {
      // 1. Get device info to find device profile
      const deviceInfo = await this.getDeviceInfo(config.deviceId, config.tbToken);
      const deviceProfileId = deviceInfo.deviceProfileId?.id;

      if (!deviceProfileId) {
        throw new Error('Device profile not found for device');
      }

      // 2. Read firmware file
      const firmwareBuffer = await fs.readFile(config.binPath);
      const fileStats = await fs.stat(config.binPath);
      const fileName = path.basename(config.binPath);

      // 3. Create OTA package
      const formData = new FormData();
      formData.append('file', firmwareBuffer, {
        filename: fileName,
        contentType: 'application/octet-stream',
      });
      
      // Add package metadata
      const packageData = {
        title: config.title || `Firmware ${config.version}`,
        version: config.version,
        deviceProfileId: {
          entityType: 'DEVICE_PROFILE',
          id: deviceProfileId,
        },
        type: 'FIRMWARE',
        description: config.description || 'Auto-generated firmware from Wiring Studio',
      };

      formData.append('data', JSON.stringify(packageData));

      // 4. Upload to ThingsBoard
      const uploadResponse = await axios.post(
        `${this.tbBaseUrl}/api/otaPackage`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'Authorization': `Bearer ${config.tbToken}`,
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }
      );

      const packageId = uploadResponse.data.id?.id;
      if (!packageId) {
        throw new Error('Failed to create OTA package');
      }

      console.log('OTA package created:', packageId);

      // 5. Assign firmware to device
      await this.assignFirmwareToDevice(
        config.deviceId,
        packageId,
        config.tbToken
      );

      console.log('Firmware assigned to device:', config.deviceId);

      return {
        success: true,
        packageId,
      };

    } catch (error: any) {
      console.error('OTA upload failed:', error.message);
      if (error.response) {
        console.error('Response:', error.response.data);
      }
      
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get device information
   */
  private async getDeviceInfo(deviceId: string, token: string): Promise<any> {
    const response = await axios.get(
      `${this.tbBaseUrl}/api/device/${deviceId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return response.data;
  }

  /**
   * Assign firmware package to device
   */
  private async assignFirmwareToDevice(
    deviceId: string,
    packageId: string,
    token: string
  ): Promise<void> {
    await axios.post(
      `${this.tbBaseUrl}/api/device/${deviceId}/firmware`,
      {
        id: {
          entityType: 'OTA_PACKAGE',
          id: packageId,
        },
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  }

  /**
   * Get OTA package info
   */
  async getPackageInfo(packageId: string, token: string): Promise<any> {
    const response = await axios.get(
      `${this.tbBaseUrl}/api/otaPackage/${packageId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return response.data;
  }

  /**
   * List OTA packages for device profile
   */
  async listPackages(deviceProfileId: string, token: string): Promise<any[]> {
    const response = await axios.get(
      `${this.tbBaseUrl}/api/otaPackages`,
      {
        params: {
          deviceProfileId,
          type: 'FIRMWARE',
          pageSize: 50,
          page: 0,
        },
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return response.data.data || [];
  }

  /**
   * Delete OTA package
   */
  async deletePackage(packageId: string, token: string): Promise<void> {
    await axios.delete(
      `${this.tbBaseUrl}/api/otaPackage/${packageId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  }
}
