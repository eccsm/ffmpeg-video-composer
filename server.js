'use strict';

const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;

const execAsync = promisify(exec);

// ============================================================================
// CONFIGURATION
// ============================================================================

class ServerConfig {
  static PORT = process.env.PORT || 3000;
  static HOST = '0.0.0.0';
  static TIMEOUT_MS = 300000;
  static MAX_FILE_SIZE = 100 * 1024 * 1024;
  static MAX_BUFFER = 50 * 1024 * 1024;
  static FFMPEG_TIMEOUT = 240000;
}

class QualityPresets {
  static PRESETS = {
    high: {
      videoPreset: 'fast',
      videoCrf: 18,
      audioBitrate: '256k',
      baseWidth: 1080,
    },
    draft: {
      videoPreset: 'veryfast',
      videoCrf: 23,
      audioBitrate: '192k',
      baseWidth: 1080,
    },
  };

  static get(quality) {
    return this.PRESETS[quality] || this.PRESETS.draft;
  }
}

// ============================================================================
// FILE MANAGEMENT
// ============================================================================

class FileManager {
  static async cleanup(paths = []) {
    for (const path of paths) {
      if (!path) continue;
      try {
        await fs.unlink(path);
      } catch (err) {
        console.error('Cleanup error for', path, err.message);
      }
    }
  }

  static async validateFile(path) {
    try {
      const stats = await fs.stat(path);
      return stats.isFile() && stats.size > 0;
    } catch {
      return false;
    }
  }

  static generateOutputPath() {
    return `/tmp/output_${Date.now()}.mp4`;
  }
}

// ============================================================================
// SUBTITLE PROCESSING
// ============================================================================

class SubtitleProcessor {
  static async processSubtitleFile(subtitlePath) {
    try {
      const content = await fs.readFile(subtitlePath, 'utf8');

      // JSON wrapper olabilir
      let assContent = content;
      try {
        const parsed = JSON.parse(content);
        if (parsed.ass) {
          assContent = parsed.ass;
        } else if (Array.isArray(parsed) && parsed[0]?.ass) {
          assContent = parsed[0].ass;
        }
      } catch {
        // JSON değilse raw ASS kabul ediyoruz
      }

      assContent = this.modifyAssStyles(assContent);

      const processedPath = `${subtitlePath}_processed.ass`;
      await fs.writeFile(processedPath, assContent, 'utf8');

      return processedPath;
    } catch (err) {
      console.error('Subtitle processing error:', err);
      throw new Error('Failed to process subtitle file');
    }
  }

  static modifyAssStyles(assContent) {
  // 1) Font size: sadece fontsize değerini büyüt
  assContent = assContent.replace(
    /Style:(.*?),([^,]+),(\d+),/g,
    (match, name, font, size) => {
      const newSize = Math.min(Number(size) + 24, 120);
      return `Style:${name},${font},${newSize},`;
    }
  );

  // 2) MarginV: sadece dikey marjin, yatay marjinleri bozma
  assContent = assContent.replace(
    /Style:(.*?),([^,]*?,){9}(\d+),(\d+),(\d+)/g,
    (match, prefix, skip, marginL, marginR, marginV) => {
      return match.replace(/(\d+)$/, "260"); // sadece MarginV = 260
    }
  );

  // 3) Ayrıca ASS içindeki diğer MarginV tanımlarını da güvenli şekilde değiştir
  assContent = assContent.replace(/(MarginV=)(\d+)/g, '$1260');

  return assContent;
}

  static escapeForFFmpeg(path) {
    return path
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "'\\''")
      .replace(/:/g, '\\:');
  }
}

// ============================================================================
// FFMPEG FILTER BUILDER (video only)
// ============================================================================

class FilterBuilder {
  constructor(baseWidth) {
    this.baseWidth = baseWidth;
    this.targetHeight = Math.round(baseWidth * 16 / 9);
    this.currentLabel = '[cv]';
    this.filters = [];
  }

  addBaseFilters() {
    this.filters.push(
      `[0:v]scale=${this.baseWidth}:-2,setsar=1:1,boxblur=luma_radius=10:luma_power=1[bg]`
    );
    this.filters.push(
      `[bg]crop=${this.baseWidth}:${this.targetHeight}:(in_w-${this.baseWidth})/2:(in_h-${this.targetHeight})/2[cv]`
    );
    return this;
  }

  addSubtitles(subtitlePath) {
    if (!subtitlePath) return this;

    const escaped = SubtitleProcessor.escapeForFFmpeg(subtitlePath);
    const newLabel = '[subbed]';

    this.filters.push(
      `${this.currentLabel}subtitles='${escaped}'${newLabel}`
    );
    this.currentLabel = newLabel;

    console.log('Subtitles filter added for:', subtitlePath);
    return this;
  }

  addTextOverlay(text) {
    if (!text) return this;

    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "'\\''")
      .replace(/\n/g, '\\n');

    const newLabel = '[final]';

    this.filters.push(
      `${this.currentLabel}drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:` +
      `text='${escaped}':x=(w-text_w)/2:y=h-400:fontsize=56:fontcolor=white:` +
      `box=1:boxcolor=black@0.45:boxborderw=20:line_spacing=20${newLabel}`
    );
    this.currentLabel = newLabel;

    console.log('Text overlay added');
    return this;
  }

  build() {
    return {
      filterComplex: this.filters.join(';'),
      outputLabel: this.currentLabel,
    };
  }
}

// ============================================================================
// FFMPEG COMMAND BUILDER
// ============================================================================

class FFmpegCommandBuilder {
  constructor(videoPath, audioPath, outputPath) {
    this.videoPath = videoPath;
    this.audioPath = audioPath;
    this.outputPath = outputPath;
    this.preset = null;
    this.filterComplex = '';
    this.outputLabel = '[cv]';
    this.useShortest = false;
  }

  setQuality(preset) {
    this.preset = preset;
    return this;
  }

  setFilter(filterComplex, outputLabel) {
    this.filterComplex = filterComplex;
    this.outputLabel = outputLabel;
    return this;
  }

  setUseShortest(flag) {
    this.useShortest = !!flag;
    return this;
  }

  build() {
    if (!this.preset) {
      throw new Error('Quality preset not set');
    }

    const args = [
      'ffmpeg',
      '-y',
      '-threads', '2',
      '-loglevel', 'info',
      `-i "${this.videoPath}"`,
      `-i "${this.audioPath}"`,
      `-filter_complex "${this.filterComplex}"`,
      `-map ${this.outputLabel}`,
      '-map 1:a?',                // audio’ya dokunmuyoruz
      '-c:v', 'libx264',
      '-preset', this.preset.videoPreset,
      '-crf', String(this.preset.videoCrf),
      '-x264-params', 'threads=2',
      '-r', '30',
      '-c:a', 'aac',
      '-b:a', this.preset.audioBitrate,
    ];

    if (this.useShortest) {
      // ✨ video/audio süresini en kısa stream’e kes
      args.push('-shortest');
    }

    args.push(
      '-movflags', '+faststart',
      `"${this.outputPath}"`
    );

    return args.join(' ');
  }
}

// ============================================================================
// VIDEO COMPOSER SERVICE
// ============================================================================

class VideoComposer {
  async compose(videoPath, audioPath, options = {}) {
    const {
      subtitlesPath,
      script,
      quality = 'draft',
      cutMode = 'video', // 'audio' | 'shortest' | 'video'
    } = options;

    const outputPath = FileManager.generateOutputPath();
    const preset = QualityPresets.get(quality);
    let processedSubtitlePath = null;

    try {
      // Process subtitles if provided
      if (subtitlesPath) {
        processedSubtitlePath = await SubtitleProcessor.processSubtitleFile(subtitlesPath);
        console.log('Subtitle processed:', processedSubtitlePath);
      }

      // Build video filter chain
      const filterBuilder = new FilterBuilder(preset.baseWidth);
      const { filterComplex, outputLabel } = filterBuilder
        .addBaseFilters()
        .addSubtitles(processedSubtitlePath)
        .addTextOverlay(script)
        .build();

      const normalizedCut = String(cutMode || 'video').toLowerCase();
      const useShortest = normalizedCut === 'audio' || normalizedCut === 'shortest';

      // Build and execute FFmpeg command
      const command = new FFmpegCommandBuilder(videoPath, audioPath, outputPath)
        .setQuality(preset)
        .setFilter(filterComplex, outputLabel)
        .setUseShortest(useShortest)
        .build();

      console.log('Executing FFmpeg command...');
      console.log('Command:', command);

      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: ServerConfig.MAX_BUFFER,
        timeout: ServerConfig.FFMPEG_TIMEOUT,
      });

      if (stdout) console.log('FFmpeg stdout (first 500):', stdout.slice(0, 500));
      if (stderr) console.log('FFmpeg stderr (first 500):', stderr.slice(0, 500));

      const isValid = await FileManager.validateFile(outputPath);
      if (!isValid) {
        throw new Error('Output file is empty or missing');
      }

      return {
        outputPath,
        processedSubtitlePath,
      };
    } catch (error) {
      await FileManager.cleanup([outputPath, processedSubtitlePath]);
      throw error;
    }
  }
}

// ============================================================================
// HTTP MIDDLEWARE
// ============================================================================

class CorsMiddleware {
  static handle(req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  }
}

class TimeoutMiddleware {
  static handle(req, res, next) {
    req.setTimeout(ServerConfig.TIMEOUT_MS);
    res.setTimeout(ServerConfig.TIMEOUT_MS);
    next();
  }
}

// ============================================================================
// REQUEST HANDLER
// ============================================================================

class ComposeRequestHandler {
  constructor(videoComposer) {
    this.videoComposer = videoComposer;
  }

  async handle(req, res) {
    const startTime = Date.now();
    const filePaths = {
      video: null,
      audio: null,
      subtitles: null,
      output: null,
      processedSubtitles: null,
    };

    try {
      console.log('=== NEW REQUEST ===');
      console.log('Files received:', {
        video: req.files?.video?.[0]?.size || 0,
        audio: req.files?.audio?.[0]?.size || 0,
        subtitles: req.files?.subtitles?.[0]?.size || 0,
      });

      if (!req.files?.video || !req.files?.audio) {
        return res.status(400).json({
          error: 'Missing video or audio file',
          received: Object.keys(req.files || {}),
        });
      }

      filePaths.video = req.files.video[0].path;
      filePaths.audio = req.files.audio[0].path;
      filePaths.subtitles = req.files.subtitles?.[0]?.path;

      // cutMode hem query’den hem body’den okunabilir
      const cutMode =
        (req.body.cutMode ||
          req.query.cutMode ||
          'video');

      const { outputPath, processedSubtitlePath } = await this.videoComposer.compose(
        filePaths.video,
        filePaths.audio,
        {
          subtitlesPath: filePaths.subtitles,
          script: req.body.script || '',
          quality: (req.body.quality || 'draft').toLowerCase(),
          cutMode,
        }
      );

      filePaths.output = outputPath;
      filePaths.processedSubtitles = processedSubtitlePath;

      console.log('Composition completed in', Date.now() - startTime, 'ms');

      const stats = await fs.stat(outputPath);
      console.log('Output size:', stats.size, 'bytes');

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Disposition', 'attachment; filename="composed.mp4"`');

      const fileStream = require('fs').createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('end', async () => {
        console.log('File sent successfully');
        await FileManager.cleanup(Object.values(filePaths));
        console.log('Cleanup completed');
      });
    } catch (error) {
      console.error('=== ERROR ===');
      console.error('Message:', error.message);
      console.error('Stack:', error.stack);

      await FileManager.cleanup(Object.values(filePaths));

      res.status(500).json({
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
  }
}

// ============================================================================
// APPLICATION SETUP
// ============================================================================

function createApp() {
  const app = express();

  const upload = multer({
    dest: '/tmp/',
    limits: { fileSize: ServerConfig.MAX_FILE_SIZE },
  });

  app.use(TimeoutMiddleware.handle);
  app.use(CorsMiddleware.handle);

  app.get('/', (req, res) => {
    res.json({
      status: 'ok',
      service: 'FFmpeg Video Composer',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    });
  });

  const videoComposer = new VideoComposer();
  const requestHandler = new ComposeRequestHandler(videoComposer);

  app.post(
    '/compose',
    upload.fields([
      { name: 'video', maxCount: 1 },
      { name: 'audio', maxCount: 1 },
      { name: 'subtitles', maxCount: 1 },
    ]),
    (req, res) => requestHandler.handle(req, res)
  );

  return app;
}

// ============================================================================
// SERVER BOOTSTRAP
// ============================================================================

console.log('🟦 Server starting...');
console.log('Node version:', process.version);
console.log('PWD:', process.cwd());
console.log('PORT:', ServerConfig.PORT);

const app = createApp();

const server = app.listen(ServerConfig.PORT, ServerConfig.HOST, () => {
  console.log(`✅ FFmpeg service running on port ${ServerConfig.PORT}`);
  console.log('Memory on start:', process.memoryUsage());
});

process.on('SIGTERM', () => {
  console.log('⚠️  Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed, exiting.');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled rejection:', reason);
});
