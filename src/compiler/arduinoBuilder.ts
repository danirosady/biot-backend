import { execa } from 'execa';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export interface BuildConfig {
  code: string;
  boardType: string; // e.g., "esp32:esp32:doit-devkit-v1"
  libraries?: string[]; // Optional: manually specify libraries
}

export interface BuildResult {
  success: boolean;
  binPath?: string;
  logs: string[];
  error?: string;
}

/**
 * Arduino CLI wrapper for compiling firmware
 */
export class ArduinoBuilder {
  private arduinoCliPath: string;
  private workDir: string;

  constructor(arduinoCliPath?: string) {
    this.arduinoCliPath = arduinoCliPath || process.env.ARDUINO_CLI_PATH || 'arduino-cli';
    this.workDir = '';
  }

  /**
   * Compile Arduino code to .bin file
   */
  async compile(config: BuildConfig): Promise<BuildResult> {
    const logs: string[] = [];
    
    try {
      // Create temporary work directory
      this.workDir = await this.createWorkDir();
      logs.push(`Created work directory: ${this.workDir}`);

      // Write code to .ino file
      const sketchName = 'firmware';
      const sketchDir = path.join(this.workDir, sketchName);
      await fs.mkdir(sketchDir, { recursive: true });
      
      const inoPath = path.join(sketchDir, `${sketchName}.ino`);
      await fs.writeFile(inoPath, config.code, 'utf-8');
      logs.push(`Written code to: ${inoPath}`);

      // Detect required libraries from #include statements
      const libraries = config.libraries || this.extractLibraries(config.code);
      logs.push(`Detected libraries: ${libraries.join(', ') || 'none'}`);

      // Install libraries
      for (const lib of libraries) {
        try {
          logs.push(`Installing library: ${lib}`);
          const installResult = await this.installLibrary(lib);
          logs.push(installResult);
        } catch (error: any) {
          // Library might already be installed, continue
          logs.push(`Library install warning: ${error.message}`);
        }
      }

      // Compile sketch
      logs.push(`Compiling for board: ${config.boardType}`);
      const buildDir = path.join(sketchDir, 'build');
      await fs.mkdir(buildDir, { recursive: true });

      const compileResult = await execa(this.arduinoCliPath, [
        'compile',
        '--fqbn', config.boardType,
        '--output-dir', buildDir,
        sketchDir
      ]);

      logs.push('Compilation stdout:', compileResult.stdout);
      if (compileResult.stderr) {
        logs.push('Compilation stderr:', compileResult.stderr);
      }

      // Find the .bin file
      const binPath = await this.findBinFile(buildDir);
      if (!binPath) {
        throw new Error('Compiled .bin file not found');
      }

      logs.push(`Compilation successful! Binary at: ${binPath}`);

      return {
        success: true,
        binPath,
        logs,
      };

    } catch (error: any) {
      logs.push(`Compilation failed: ${error.message}`);
      if (error.stdout) logs.push('stdout:', error.stdout);
      if (error.stderr) logs.push('stderr:', error.stderr);

      return {
        success: false,
        logs,
        error: error.message,
      };
    }
  }

  /**
   * Install Arduino library
   */
  private async installLibrary(libraryName: string): Promise<string> {
    const result = await execa(this.arduinoCliPath, [
      'lib', 'install', libraryName
    ]);
    return result.stdout || `Installed: ${libraryName}`;
  }

  /**
   * Extract library names from #include statements
   */
  private extractLibraries(code: string): string[] {
    const libraries = new Set<string>();
    const includeRegex = /#include\s*[<"]([^>"]+)[>"]/g;
    
    let match;
    while ((match = includeRegex.exec(code)) !== null) {
      const header = match[1];
      
      // Map common headers to library names
      const libraryMap: Record<string, string> = {
        'DHT.h': 'DHT sensor library',
        'Ultrasonic.h': 'Ultrasonic',
        'DallasTemperature.h': 'DallasTemperature',
        'OneWire.h': 'OneWire',
        'ThingsBoard.h': 'ThingsBoard',
        // WiFi.h and other ESP32 core libraries don't need installation
      };

      if (libraryMap[header]) {
        libraries.add(libraryMap[header]);
      }
    }

    return Array.from(libraries);
  }

  /**
   * Find the compiled .bin file
   */
  private async findBinFile(buildDir: string): Promise<string | null> {
    try {
      const files = await fs.readdir(buildDir);
      const binFile = files.find(f => f.endsWith('.bin'));
      
      if (binFile) {
        return path.join(buildDir, binFile);
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Create temporary work directory
   */
  private async createWorkDir(): Promise<string> {
    const tmpBase = os.tmpdir();
    const workDir = path.join(tmpBase, `wiring-studio-build-${Date.now()}`);
    await fs.mkdir(workDir, { recursive: true });
    return workDir;
  }

  /**
   * Clean up work directory
   */
  async cleanup(): Promise<void> {
    if (this.workDir) {
      try {
        await fs.rm(this.workDir, { recursive: true, force: true });
      } catch (error) {
        console.error('Failed to cleanup work directory:', error);
      }
    }
  }

  /**
   * Copy compiled binary to permanent storage
   */
  async copyToStorage(binPath: string, targetDir: string, filename: string): Promise<string> {
    await fs.mkdir(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, filename);
    await fs.copyFile(binPath, targetPath);
    return targetPath;
  }

  /**
   * Check if Arduino CLI is available
   */
  async checkArduinoCli(): Promise<boolean> {
    try {
      const result = await execa(this.arduinoCliPath, ['version']);
      console.log('Arduino CLI version:', result.stdout);
      return true;
    } catch (error) {
      console.error('Arduino CLI not found. Please install it: https://arduino.github.io/arduino-cli/');
      return false;
    }
  }

  /**
   * Install ESP32 board support if needed
   */
  async installEsp32Board(): Promise<void> {
    try {
      // Add ESP32 board manager URL
      await execa(this.arduinoCliPath, [
        'config', 'add',
        'board_manager.additional_urls',
        'https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json'
      ]);

      // Update board index
      await execa(this.arduinoCliPath, ['core', 'update-index']);

      // Install ESP32 core
      await execa(this.arduinoCliPath, ['core', 'install', 'esp32:esp32']);

      console.log('ESP32 board support installed');
    } catch (error: any) {
      console.error('Failed to install ESP32 board:', error.message);
      throw error;
    }
  }
}
