const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;

const execAsync = promisify(exec);
const app = express();

const upload = multer({ 
  dest: '/tmp/',
  limits: { fileSize: 50 * 1024 * 1024 } 
});

// INCREASE REQUEST TIMEOUT
app.use((req, res, next) => {
  req.setTimeout(300000); 
  res.setTimeout(300000); 
  next();
});

// Enable CORS for n8n
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'FFmpeg Video Composer',
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

app.post('/compose', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  const startTime = Date.now();
  let videoPath, audioPath, outputPath;
  
  try {
    console.log('=== NEW REQUEST ===');
    console.log('Files received:', {
      video: req.files?.video?.[0]?.size || 0,
      audio: req.files?.audio?.[0]?.size || 0
    });
    
    if (!req.files?.video || !req.files?.audio) {
      console.error('Missing files!');
      return res.status(400).json({ 
        error: 'Missing video or audio file',
        received: Object.keys(req.files || {})
      });
    }

    videoPath = req.files.video[0].path;
    audioPath = req.files.audio[0].path;
    outputPath = `/tmp/output_${Date.now()}.mp4`;
    
    const script = req.body.script || '';
    console.log('Script length:', script.length);
    
    let filterComplex = 
      '[0:v]scale=1080:-2,setsar=1:1,boxblur=luma_radius=10:luma_power=1[bg];' +
      '[bg]crop=1080:1920:(in_w-1080)/2:(in_h-1920)/2[cv]';
    
    let mapVideo = '[cv]';
    
    if (script) {
      const scriptEscaped = script
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "'\\''")
        .replace(/\n/g, '\\n');
      
      filterComplex += 
        `;[cv]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:` +
        `text='${scriptEscaped}':x=(w-text_w)/2:y=h-400:fontsize=56:fontcolor=white:` +
        `box=1:boxcolor=black@0.45:boxborderw=20:line_spacing=20[final]`;
      
      mapVideo = '[final]';
    }
    
    const ffmpegCmd = [
      'ffmpeg', '-y',
      `-i "${videoPath}"`,
      `-i "${audioPath}"`,
      `-filter_complex "${filterComplex}"`,
      `-map ${mapVideo}`,
      '-map 1:a',
      '-c:v libx264',
      '-preset ultrafast', 
      '-crf 28', 
      '-r 30',
      '-c:a aac',
      '-b:a 128k',
      '-shortest',
      '-movflags +faststart',
      `"${outputPath}"`
    ].join(' ');
    
    console.log('Starting FFmpeg...');
    console.log('Command:', ffmpegCmd.substring(0, 200) + '...');
    
    const { stdout, stderr } = await execAsync(ffmpegCmd, { 
      maxBuffer: 50 * 1024 * 1024,
      timeout: 240000 // 4 minute timeout
    });
    
    console.log('FFmpeg completed in', Date.now() - startTime, 'ms');
    
    const stats = await fs.stat(outputPath);
    console.log('Output size:', stats.size, 'bytes');
    
    if (!stats.isFile() || stats.size === 0) {
      throw new Error('Output file is empty or missing');
    }
    
    // Send file
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', 'attachment; filename="composed.mp4"');
    
    const fileStream = require('fs').createReadStream(outputPath);
    fileStream.pipe(res);
    
    fileStream.on('end', async () => {
      console.log('File sent successfully');
      try {
        await fs.unlink(videoPath);
        await fs.unlink(audioPath);
        await fs.unlink(outputPath);
        console.log('Cleanup completed');
      } catch (err) {
        console.error('Cleanup error:', err);
      }
    });
    
  } catch (error) {
    console.error('=== ERROR ===');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
    
    try {
      if (videoPath) await fs.unlink(videoPath);
      if (audioPath) await fs.unlink(audioPath);
      if (outputPath) await fs.unlink(outputPath);
    } catch {}
    
    res.status(500).json({ 
      error: error.message,
      details: error.stderr || error.stdout || 'No details',
      duration: Date.now() - startTime
    });
  }
});

// En alttaki listen kısmını şöyle değiştir:

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ FFmpeg service running on port ${PORT}`);
  console.log(`Memory on start:`, process.memoryUsage());
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

process.on('unhandledRejection', (reason, p) => {
  console.error('💥 Unhandled rejection:', reason);
});

