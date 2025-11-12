// server.js - FFmpeg Video Composition Service for Render.com
const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);
const app = express();
const upload = multer({ dest: '/tmp/' });

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'FFmpeg Video Composition',
    endpoints: {
      compose: 'POST /compose - Compose video with audio and text overlay'
    }
  });
});

// Main composition endpoint
app.post('/compose', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  let videoPath, audioPath, outputPath;
  
  try {
    // Validate uploads
    if (!req.files || !req.files.video || !req.files.audio) {
      return res.status(400).json({ 
        error: 'Missing required files. Send video and audio as multipart form data' 
      });
    }

    videoPath = req.files.video[0].path;
    audioPath = req.files.audio[0].path;
    outputPath = `/tmp/output_${Date.now()}.mp4`;
    
    const script = req.body.script || '';
    
    // Build filter complex
    let filterComplex = 
      '[0:v]scale=1080:-2,setsar=1:1,boxblur=luma_radius=10:luma_power=1[bg];' +
      '[bg]crop=1080:1920:(in_w-1080)/2:(in_h-1920)/2[cv]';
    
    let mapVideo = '[cv]';
    
    if (script) {
      // Escape script for FFmpeg
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
    
    // Build FFmpeg command
    const ffmpegCmd = [
      'ffmpeg',
      '-y',
      `-i "${videoPath}"`,
      `-i "${audioPath}"`,
      `-filter_complex "${filterComplex}"`,
      `-map ${mapVideo}`,
      '-map 1:a',
      '-c:v libx264',
      '-preset medium',
      '-crf 23',
      '-r 30',
      '-c:a aac',
      '-b:a 128k',
      '-shortest',
      '-movflags +faststart',
      `"${outputPath}"`
    ].join(' ');
    
    console.log('Running FFmpeg...');
    
    // Execute FFmpeg
    const { stdout, stderr } = await execAsync(ffmpegCmd, {
      maxBuffer: 50 * 1024 * 1024 // 50MB buffer
    });
    
    console.log('FFmpeg completed successfully');
    
    // Check if output file exists
    const stats = await fs.stat(outputPath);
    if (!stats.isFile()) {
      throw new Error('Output file was not created');
    }
    
    // Send the video file
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', 'attachment; filename="composed.mp4"');
    
    const fileStream = require('fs').createReadStream(outputPath);
    fileStream.pipe(res);
    
    // Cleanup after sending
    fileStream.on('end', async () => {
      try {
        await fs.unlink(videoPath);
        await fs.unlink(audioPath);
        await fs.unlink(outputPath);
      } catch (err) {
        console.error('Cleanup error:', err);
      }
    });
    
  } catch (error) {
    console.error('Error:', error);
    
    // Cleanup on error
    try {
      if (videoPath) await fs.unlink(videoPath);
      if (audioPath) await fs.unlink(audioPath);
      if (outputPath) await fs.unlink(outputPath);
    } catch (cleanupErr) {
      console.error('Cleanup error:', cleanupErr);
    }
    
    res.status(500).json({ 
      error: error.message,
      details: error.stderr || error.stdout || 'No additional details'
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FFmpeg service running on port ${PORT}`);
});