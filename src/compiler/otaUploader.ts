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

      // 3. Create OTA package info (JSON metadata only)
      const packageInfoPayload = {
        title: config.title || `Firmware ${config.version}`,
        version: config.version,
        deviceProfileId: {
          entityType: 'DEVICE_PROFILE',
          id: deviceProfileId,
        },
        type: 'FIRMWARE',
        description: config.description || 'Auto-generated firmware from Wiring Studio',
      };

      const infoResponse = await axios.post(
        `${this.tbBaseUrl}/api/otaPackage`,
        packageInfoPayload,
        {
          headers: {
            'Authorization': `Bearer ${config.tbToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
        }
      );

      const packageId = infoResponse.data?.id?.id;
      if (!packageId) {
        throw new Error('Failed to create OTA package info');
      }

      // 4. Upload OTA package data (binary file) to created package id
      const formData = new FormData();
      formData.append('file', firmwareBuffer, {
        filename: fileName,
        contentType: 'application/octet-stream',
      });

      const boundary = (formData as any).getBoundary?.();
      const multipartBody = (formData as any).getBuffer?.();
      if (!boundary || !multipartBody) {
        throw new Error('Failed to build multipart form body for OTA upload');
      }

      const multipartHeaders: Record<string, string> = {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(multipartBody.length),
      };

      await axios.post(
        `${this.tbBaseUrl}/api/otaPackage/${packageId}?checksumAlgorithm=SHA256`,
        multipartBody,
        {
          headers: {
            ...multipartHeaders,
            'Authorization': `Bearer ${config.tbToken}`,
            'Accept': 'application/json',
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }
      );

      console.log('OTA package created and data uploaded:', packageId);

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
      const details = this.formatAxiosError(error);
      console.error('OTA upload failed:', details);
      
      return {
        success: false,
        error: details,
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
    const headers = { Authorization: `Bearer ${token}` };
    const allowLegacyFallback = (process.env.TB_LEGACY_ASSIGN_FALLBACK || 'false').toLowerCase() === 'true';

    // Preferred ThingsBoard endpoint for assigning OTA package to device.
    try {
      await axios.post(
        `${this.tbBaseUrl}/api/otaPackage/${packageId}/assign/${deviceId}`,
        {},
        { headers }
      );
      return;
    } catch (primaryError: any) {
      const primaryDetails = this.formatAxiosError(primaryError);
      const status = primaryError?.response?.status;
      // Some ThingsBoard distributions do not expose assign endpoint.
      // In this case, package upload is still valid and can be used by OTA checks.
      if (status === 404) {
        console.warn(`Assign endpoint not available on server, skipping device assignment: ${primaryDetails}`);
        return;
      }
      if (!allowLegacyFallback) {
        throw new Error(`Failed to assign OTA package with modern endpoint: ${primaryDetails}`);
      }
      console.warn('Primary OTA assign endpoint failed, trying legacy endpoint:', primaryDetails);
    }

    // Legacy fallback endpoint.
    await axios.post(
      `${this.tbBaseUrl}/api/device/${deviceId}/firmware`,
      {
        id: {
          entityType: 'OTA_PACKAGE',
          id: packageId,
        },
      },
      { headers }
    );
  }

  private formatAxiosError(error: any): string {
    const status = error?.response?.status;
    const statusText = error?.response?.statusText;
    const data = error?.response?.data;
    const method = error?.config?.method?.toUpperCase?.();
    const url = error?.config?.url;
    const base = error?.message || 'Unknown error';
    const responseInfo = status ? `status=${status}${statusText ? ` ${statusText}` : ''}` : 'no-status';
    const requestInfo = method && url ? `${method} ${url}` : 'unknown-request';
    const payload = data ? ` response=${JSON.stringify(data)}` : '';
    return `${base} [${requestInfo}] [${responseInfo}]${payload}`;
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
