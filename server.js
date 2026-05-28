const express = require('express')
const multer = require('multer')
const { exec } = require('child_process')
const fs = require('fs-extra')
const axios = require('axios')
const FormData = require('form-data')
const path = require('path')
const cors = require('cors')

const app = express()
const upload = multer({ dest: 'uploads/' })
const NODEODM_URL = process.env.NODEODM_URL || 'http://localhost:3000'

app.use(cors())
app.use(express.json())

app.post('/api/process-video', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded' })

  const videoPath = req.file.path
  const uniqueId = req.file.filename
  const outputFolder = path.join(__dirname, 'frames', uniqueId)

  try {
    await fs.ensureDir(outputFolder)
  } catch (err) {
    return res.status(500).json({ error: 'Could not prepare frame folder' })
  }

  // Extract frames at 2 fps
  const ffmpegCmd = `ffmpeg -y -i "${videoPath}" -vf "fps=2" "${path.join(outputFolder, 'img_%04d.jpg')}"`

  exec(ffmpegCmd, async (err, stdout, stderr) => {
    if (err) {
      console.error('ffmpeg error', err, stderr)
      await fs.remove(videoPath).catch(() => {})
      return res.status(500).json({ error: 'Frame extraction failed' })
    }

    try {
      const files = await fs.readdir(outputFolder)
      if (!files.length) throw new Error('No frames created')

      const form = new FormData()
      for (const file of files) {
        form.append('images', fs.createReadStream(path.join(outputFolder, file)))
      }

      // Default processing options for high-detail mesh; adjust as needed
      form.append('options', JSON.stringify([
        { name: 'mesh-size', value: 150000 },
        { name: 'texturing-dataterm', value: 'gtext' }
      ]))

      const odmRes = await axios.post(`${NODEODM_URL}/task/new`, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      })

      // cleanup uploaded video (keep frames for inspection)
      await fs.remove(videoPath).catch(() => {})

      // respond with task token / uuid
      return res.json({ token: odmRes.data.uuid || odmRes.data.task_id || odmRes.data.id })
    } catch (odmErr) {
      console.error('ODM submit error', odmErr)
      await fs.remove(videoPath).catch(() => {})
      return res.status(500).json({ error: 'Local 3D calculation node rejected task payload' })
    }
  })
})

const PORT = process.env.PORT || 5000
app.listen(PORT, () => console.log(`Secure Processing Gateway Online at Port ${PORT}`))
