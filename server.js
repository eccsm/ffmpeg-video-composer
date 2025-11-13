const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;

const execAsync = promisify(exec);
const app = express();
const upload = multer({ dest: '/tmp/' });

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'FFmpeg Video Composer',
    provider: 'Railway (FREE)'
  });
});

app.post('/compose', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  let videoPath, audioPath, outputPath;
  
  try {
    if (!req.files?.video || !req.files?.audio) {
      return res.status(400).json({ 
        error: 'Missing video or audio file' 
      });
    }

    videoPath = req.files.video[0].path;
    audioPath = req.files.audio[0].path;
    outputPath = `/tmp/output_${Date.now()}.mp4`;
    
    const script = req.body.script || '';
    
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
      '-preset medium',
      '-crf 23',
      '-r 30',
      '-c:a aac',
      '-b:a 128k',
      '-shortest',
      '-movflags +faststart',
      `"${outputPath}"`
    ].join(' ');
    
    console.log('Processing video...');
    await execAsync(ffmpegCmd, { maxBuffer: 50 * 1024 * 1024 });
    
    const stats = await fs.stat(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stats.size);
    
    const fileStream = require('fs').createReadStream(outputPath);
    fileStream.pipe(res);
    
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
    
    try {
      if (videoPath) await fs.unlink(videoPath);
      if (audioPath) await fs.unlink(audioPath);
      if (outputPath) await fs.unlink(outputPath);
    } catch {}
    
    res.status(500).json({ 
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FFmpeg service on port ${PORT}`);
});
