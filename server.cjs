const express = require('express')
const multer = require('multer')
const { exec } = require('child_process')
const fs = require('fs-extra')
const axios = require('axios')
const FormData = require('form-data')
const path = require('path')
const cors = require('cors')
const ffmpegPath = require('ffmpeg-static')
const AdmZip = require('adm-zip')

const app = express()
const upload = multer({ dest: 'uploads/' })
const NODEODM_URL = process.env.NODEODM_URL || 'http://localhost:3000'

app.use(cors())
app.use(express.json())
app.use('/outputs', express.static(path.join(__dirname, 'outputs')))

app.get('/api/health', async (_req, res) => {
  try {
    const node = await axios.get(`${NODEODM_URL}/`, { timeout: 2500 })
    res.json({ ok: true, ffmpeg: Boolean(ffmpegPath), nodeodm: node.status })
  } catch (error) {
    res.status(503).json({
      ok: false,
      ffmpeg: Boolean(ffmpegPath),
      nodeodm: 'unreachable',
      nodeodmUrl: NODEODM_URL,
    })
  }
})

app.get('/api/nodeodm/tasks', async (_req, res) => {
  let odmTasks = []
  try {
    const response = await axios.get(`${NODEODM_URL}/task/list`, { timeout: 5000 })
    odmTasks = Array.isArray(response.data) ? response.data : []
  } catch (error) {
    console.log('Could not fetch active tasks from NodeODM, using local cache only')
  }

  // Scan outputs folder for completed tasks on disk
  const localTasks = []
  try {
    const outputsDir = path.join(__dirname, 'outputs')
    if (await fs.pathExists(outputsDir)) {
      const dirs = await fs.readdir(outputsDir)
      for (const dirName of dirs) {
        const modelPath = path.join(outputsDir, dirName, 'odm_textured_model_geo.glb')
        if (await fs.pathExists(modelPath)) {
          localTasks.push({
            uuid: dirName,
            name: `Local Cache Model (${dirName.substring(0, 8)})`,
            status: { code: 2, message: "Completed" },
            progress: 100
          })
        }
      }
    }
  } catch (err) {
    console.error('Error scanning local outputs directory:', err)
  }

  // Merge lists, prioritizing NodeODM tasks if they exist
  const taskMap = new Map()
  for (const task of localTasks) {
    taskMap.set(task.uuid, task)
  }
  for (const task of odmTasks) {
    if (task && task.uuid) {
      taskMap.set(task.uuid, task)
    }
  }

  res.json(Array.from(taskMap.values()))
})

app.get('/api/nodeodm/task/:uuid/info', async (req, res) => {
  const { uuid } = req.params
  
  // Check if the model is already cached locally on disk FIRST
  const modelPath = path.join(__dirname, 'outputs', uuid, 'odm_textured_model_geo.glb')
  if (await fs.pathExists(modelPath)) {
    const stat = await fs.stat(modelPath)
    return res.json({
      uuid: uuid,
      name: `Completed Model (${uuid.substring(0, 8)})`,
      status: { code: 40 },
      progress: 100,
      imagesCount: 0,
      dateCreated: stat.mtime.toISOString(),
    })
  }

  // Otherwise try calling NodeODM for active/in-progress tasks
  try {
    const response = await axios.get(`${NODEODM_URL}/task/${uuid}/info`, { timeout: 5000 })
    return res.json(response.data)
  } catch (error) {
    res.status(502).json({ error: 'Could not read NodeODM task info' })
  }
})

app.get('/api/nodeodm/task/:uuid/model.glb', async (req, res) => {
  const { uuid } = req.params
  const taskOutputFolder = path.join(__dirname, 'outputs', uuid)
  const modelPath = path.join(taskOutputFolder, 'odm_textured_model_geo.glb')
  const zipPath = path.join(taskOutputFolder, 'all.zip')

  try {
    await fs.ensureDir(taskOutputFolder)

    if (!(await fs.pathExists(modelPath))) {
      const response = await axios.get(`${NODEODM_URL}/task/${uuid}/download/all.zip?token=`, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      })

      await fs.writeFile(zipPath, Buffer.from(response.data))
      const zip = new AdmZip(zipPath)
      const entry = zip.getEntry('odm_texturing/odm_textured_model_geo.glb')

      if (!entry) {
        return res.status(404).json({ error: 'Completed task did not include a GLB model' })
      }

      await fs.writeFile(modelPath, entry.getData())
    }

    res.type('model/gltf-binary')
    res.sendFile(modelPath)
  } catch (error) {
    console.error('Model extraction error', error)
    res.status(502).json({ error: 'Could not prepare model preview' })
  }
})

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
  const ffmpegCmd = `"${ffmpegPath}" -y -i "${videoPath}" -vf "fps=2" "${path.join(outputFolder, 'img_%04d.jpg')}"`

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
