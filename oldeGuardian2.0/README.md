# Discord Music Bot with Spotify and React UI

This project is a Discord bot that streams music from local files or Spotify, with a React-based web UI for control.

## Project Structure

- `backend/` - Node.js Discord bot and music streaming server
- `frontend/` - React app for controlling the bot
- `.github/` - Copilot and workflow instructions

## Features
- Play music from local files or Spotify
- React UI for play/pause, skip, queue, and volume
- Spotify API integration (requires credentials)

## Getting Started

### Prerequisites
- Node.js (LTS recommended)
- npm or yarn
- Discord account and bot token
- Spotify Developer account (for API credentials)

### Setup

#### 1. Clone the repository
```
git clone <repo-url>
cd <project-root>
```

#### 2. Backend Setup
```
cd backend
npm install
# Create a .env file with your Discord and Spotify credentials
```

#### 3. Frontend Setup
```
cd ../frontend
npm install
```

#### 4. Running the Project
- Start the backend:
```
npm start
```
- Start the frontend:
```
npm start
```

## Environment Variables
Create a `.env` file in `backend/` with:
```
DISCORD_TOKEN=your_discord_bot_token
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
SPOTIFY_REDIRECT_URI=your_spotify_redirect_uri
```

## Notes
- Replace placeholder values with your actual credentials.
- For local music, place files in a `music/` folder inside `backend/`.
- The frontend will connect to the backend via REST/WebSocket for control.

## License
MIT
