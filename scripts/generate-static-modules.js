import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const files = [
  { name: 'auth', ext: 'js', exportName: 'authJs' },
  { name: 'app', ext: 'js', exportName: 'appJs' },
  { name: 'ffmpeg', ext: 'js', exportName: 'ffmpegJs' },
  { name: 'ffmpeg-util', ext: 'js', exportName: 'ffmpegUtilJs' },
  { name: 'style', ext: 'css', exportName: 'styleCss' }
]

files.forEach(({ name, ext, exportName }) => {
  const sourcePath = path.join(__dirname, '..', 'public', 'static', `${name}.${ext}`)
  const content = fs.readFileSync(sourcePath, 'utf8')
  
  // Escape backticks, backslashes, and ${} in template literals
  const escaped = content
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
  
  const output = `export const ${exportName} = \`${escaped}\`\n`
  
  const destPath = path.join(__dirname, '..', 'src', 'static', `${name}.ts`)
  fs.writeFileSync(destPath, output)
  console.log(`✓ Generated ${destPath}`)
})
