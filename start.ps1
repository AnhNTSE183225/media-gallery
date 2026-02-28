# Start both server and client, then open browser
Write-Host "Starting server and client..." -ForegroundColor Green

# Start the server in a new PowerShell window
Write-Host "Starting server on port 3001..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd server; node server.js"

# Start the client in a new PowerShell window
Write-Host "Starting client on port 5173..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd client; npm run dev"

# Wait a few seconds for the client to start
Write-Host "Waiting for services to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Open the default browser to the client URL
Write-Host "Opening browser to http://localhost:5173" -ForegroundColor Green
Start-Process "http://localhost:5173"

Write-Host "`nBoth services are running in separate windows." -ForegroundColor Green
Write-Host "Close those windows to stop the services." -ForegroundColor Yellow
