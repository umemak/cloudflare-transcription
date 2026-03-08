// Fix _routes.json to include all routes in Workers
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const routesPath = path.join(__dirname, '..', 'dist', '_routes.json')
const routesConfig = {
  version: 1,
  include: ['/*'],
  exclude: []
}

fs.writeFileSync(routesPath, JSON.stringify(routesConfig))
console.log('✓ Fixed _routes.json to include static files in Workers')
