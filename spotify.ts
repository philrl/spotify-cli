#!/usr/bin/env bun
import { homedir } from "os";
import { join } from "path";
import * as fs from "fs";
import bun from "bun";

// Types
interface Config {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
}

interface SpotifyTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  [key: string]: any;
}

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface SpotifySearchResponse {
  playlists?: {
    items?: Array<{
      uri: string;
      name: string;
      owner?: { display_name: string };
    }>;
  };
  albums?: {
    items?: Array<{
      uri: string;
      name: string;
      artists: Array<{ name: string }>;
    }>;
  };
  artists?: { items?: Array<{ uri: string; name: string; genres: string[] }> };
  tracks?: {
    items?: Array<{
      uri: string;
      name: string;
      artists: Array<{ name: string }>;
      album: { name: string };
    }>;
  };
}

// Configuration
const USER_CONFIG_FILE = join(homedir(), ".shpotify.cfg");
const USER_CONFIG_DEFAULTS = 'CLIENT_ID=""\nCLIENT_SECRET=""';
const SPOTIFY_CLI_SERVICE = "spotify-cli";
const SPOTIFY_AUTH_URI = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URI = "https://accounts.spotify.com/api/token";
const SPOTIFY_SEARCH_API = "https://api.spotify.com/v1/search";
const OAUTH_REDIRECT_PORT = 8888;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_REDIRECT_PORT}/callback`;
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const OAUTH_SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-library-modify",
  "user-library-read",
  "user-follow-modify",
  "user-follow-read",
  "user-top-read",
].join(" ");

let config: Config = { CLIENT_ID: "", CLIENT_SECRET: "" };
let spotifyAccessToken: string = "";

// Initialize config file
function initializeConfig() {
  if (!fs.existsSync(USER_CONFIG_FILE)) {
    fs.writeFileSync(USER_CONFIG_FILE, USER_CONFIG_DEFAULTS);
  }
  loadConfig();
}

function loadConfig() {
  try {
    const content = fs.readFileSync(USER_CONFIG_FILE, "utf-8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.startsWith("CLIENT_ID=")) {
        config.CLIENT_ID = line.replace('CLIENT_ID="', "").replace('"', "");
      }
      if (line.startsWith("CLIENT_SECRET=")) {
        config.CLIENT_SECRET = line
          .replace('CLIENT_SECRET="', "")
          .replace('"', "");
      }
    }
  } catch (error) {
    cecho(`Error loading config: ${error}`);
  }
}

// PKCE Helper Functions
function generateCodeVerifier(length: number = 64): string {
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return values.reduce((acc, x) => acc + possible[x % possible.length], "");
}

async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Token Storage Functions
async function saveTokens(tokens: StoredTokens): Promise<void> {
  const tokenData = JSON.stringify(tokens);
  await Bun.secrets.set({
    service: SPOTIFY_CLI_SERVICE,
    name: "tokens",
    value: tokenData,
    allowUnrestrictedAccess: false,
  });
}

async function loadTokens(): Promise<StoredTokens | null> {
  try {
    const tokenData = await Bun.secrets.get({
      service: SPOTIFY_CLI_SERVICE,
      name: "tokens",
    });

    if (tokenData) {
      return JSON.parse(tokenData) as StoredTokens;
    }
  } catch (error) {
    // Token doesn't exist or is invalid
  }
  return null;
}

function isTokenExpired(tokens: StoredTokens): boolean {
  return Date.now() >= tokens.expires_at - 60000; // 1 minute buffer
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<StoredTokens | null> {
  if (!config.CLIENT_ID) {
    return null;
  }

  try {
    const response = await fetch(SPOTIFY_TOKEN_URI, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.CLIENT_ID,
      }),
    });

    const data = (await response.json()) as SpotifyTokenResponse;

    if (!data.access_token) {
      return null;
    }

    const tokens: StoredTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    };

    await saveTokens(tokens);
    return tokens;
  } catch (error) {
    return null;
  }
}

async function getValidAccessToken(): Promise<string | null> {
  const tokens = await loadTokens();
  if (!tokens) {
    return null;
  }

  if (isTokenExpired(tokens)) {
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    if (refreshed) {
      return refreshed.access_token;
    }
    return null;
  }

  return tokens.access_token;
}

// Centralized Spotify API request function with auto re-auth
interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: object;
  params?: Record<string, string>;
}

interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

async function spotifyApiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
  isRetry = false,
): Promise<ApiResponse<T>> {
  const { method = "GET", body, params } = options;

  // Get access token, trigger login if not available
  let accessToken = await getValidAccessToken();

  if (!accessToken) {
    if (isRetry) {
      return {
        ok: false,
        status: 401,
        error: "Failed to authenticate after retry",
      };
    }
    cecho("Not logged in. Starting login flow...");
    await login();
    accessToken = await getValidAccessToken();

    if (!accessToken) {
      return { ok: false, status: 401, error: "Failed to authenticate" };
    }
  }

  // Build URL with query params
  let url = `${SPOTIFY_API_BASE}${path}`;
  if (params) {
    const searchParams = new URLSearchParams(params);
    url += `?${searchParams.toString()}`;
  }

  // Make the request
  const fetchOptions: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  };

  if (body && method !== "GET") {
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url, fetchOptions);

  // Handle auth errors - logout, re-login, and retry once
  if ((response.status === 401 || response.status === 403) && !isRetry) {
    cecho("Authentication error. Re-authenticating...");
    await logout();
    return spotifyApiRequest<T>(path, options, true);
  }

  // Parse response
  if (!response.ok) {
    const errorText = await response.text();
    return { ok: false, status: response.status, error: errorText };
  }

  // Handle empty responses (204 No Content)
  if (response.status === 204) {
    return { ok: true, status: 204 };
  }

  const data = (await response.json()) as T;
  return { ok: true, status: response.status, data };
}

// Login Flow
async function login(): Promise<void> {
  if (!config.CLIENT_ID) {
    cecho(`Invalid Client ID, please update ${USER_CONFIG_FILE}`);
    showAPIHelp();
    return;
  }

  const codeVerifier = generateCodeVerifier(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authParams = new URLSearchParams({
    client_id: config.CLIENT_ID,
    response_type: "code",
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
  });

  const authUrl = `${SPOTIFY_AUTH_URI}?${authParams.toString()}`;

  cecho("Opening browser for Spotify login...");
  cecho("Please authorize the application in your browser.");

  // Open the browser
  await bun.$`open ${authUrl}`;

  // Start a local server to receive the callback
  let resolveAuth: (code: string) => void;
  let rejectAuth: (error: Error) => void;
  const authPromise = new Promise<string>((resolve, reject) => {
    resolveAuth = resolve;
    rejectAuth = reject;
  });

  const server = Bun.serve({
    port: OAUTH_REDIRECT_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          // Delay reject to allow response to be sent
          setTimeout(
            () => rejectAuth(new Error(`Authorization failed: ${error}`)),
            100,
          );
          return new Response(
            "<html><body><h1>Authorization Failed</h1><p>You can close this window.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }

        if (code) {
          // Delay resolve to allow response to be sent
          setTimeout(() => resolveAuth(code), 100);
          return new Response(
            "<html><body><h1>Login Successful!</h1><p>You can close this window and return to the terminal.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  // Timeout after 2 minutes
  const timeoutId = setTimeout(() => {
    rejectAuth(new Error("Login timeout - please try again"));
  }, 120000);

  let authCode: string;
  try {
    authCode = await authPromise;
  } finally {
    // Clean up: clear timeout and stop server
    clearTimeout(timeoutId);
    await server.stop(true);
  }

  cecho("Exchanging authorization code for tokens...");

  // Exchange the authorization code for tokens
  const tokenResponse = await fetch(SPOTIFY_TOKEN_URI, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: OAUTH_REDIRECT_URI,
      client_id: config.CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });

  const tokenData = (await tokenResponse.json()) as SpotifyTokenResponse;

  if (!tokenData.access_token) {
    cecho("Failed to obtain access token");
    console.log(JSON.stringify(tokenData, null, 2));
    return;
  }

  const tokens: StoredTokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || "",
    expires_at: Date.now() + (tokenData.expires_in || 3600) * 1000,
  };

  await saveTokens(tokens);
  cecho("Login successful! You are now authenticated with Spotify.");
}

// Logout function
async function logout(): Promise<void> {
  try {
    const deleted = await Bun.secrets.delete({
      service: SPOTIFY_CLI_SERVICE,
      name: "tokens",
    });

    if (deleted) {
      cecho(
        "Successfully logged out. Tokens have been removed from secure storage.",
      );
    } else {
      cecho("No stored tokens found. You were already logged out.");
    }
  } catch (error) {
    cecho("Error during logout: " + error);
  }
}

// Get current track ID from Spotify app
async function getCurrentTrackId(): Promise<string | null> {
  const trackUri = await runOsascript(
    'tell application "Spotify" to spotify url of current track',
  );

  if (!trackUri) {
    return null;
  }

  // URI format is "spotify:track:TRACK_ID"
  const match = trackUri.match(/spotify:track:(.+)/);
  return match?.[1] ?? null;
}

// Save current track to user's library
async function saveCurrentTrack(): Promise<void> {
  // Get current track info for display
  const artist = await showArtist();
  const track = await showTrack();
  const trackId = await getCurrentTrackId();

  if (!trackId) {
    cecho("No track is currently playing.");
    return;
  }

  // Save the track
  const response = await spotifyApiRequest("/me/tracks", {
    method: "PUT",
    body: { ids: [trackId] },
  });

  if (response.ok) {
    cecho(`Saved "${track}" by ${artist} to your library.`);
  } else {
    cecho(`Failed to save track: ${response.status} ${response.error}`);
  }
}

// Get track details from Spotify API (includes artist IDs)
interface TrackDetails {
  artists: Array<{ id: string; name: string }>;
  name: string;
}

async function getTrackDetails(trackId: string): Promise<TrackDetails | null> {
  const response = await spotifyApiRequest<TrackDetails>(`/tracks/${trackId}`);
  return response.ok ? (response.data ?? null) : null;
}

// Follow the artist of the current track
async function followCurrentArtist(): Promise<void> {
  // Get current track ID
  const trackId = await getCurrentTrackId();

  if (!trackId) {
    cecho("No track is currently playing.");
    return;
  }

  // Get track details to get artist ID
  const trackDetails = await getTrackDetails(trackId);

  if (!trackDetails || trackDetails.artists.length === 0) {
    cecho("Could not get artist information for the current track.");
    return;
  }

  // Get the first (primary) artist
  const artist = trackDetails.artists[0];

  if (!artist) {
    cecho("Could not get artist information for the current track.");
    return;
  }

  // Follow the artist
  const response = await spotifyApiRequest("/me/following", {
    method: "PUT",
    params: { type: "artist", ids: artist.id },
  });

  if (response.ok) {
    cecho(`Now following ${artist.name}.`);
  } else {
    cecho(`Failed to follow artist: ${response.status} ${response.error}`);
  }
}

// Types for top items response
interface TopArtist {
  name: string;
  genres: string[];
  popularity: number;
}

interface TopTrack {
  name: string;
  artists: Array<{ name: string }>;
  album: { name: string };
  popularity: number;
}

interface TopItemsResponse<T> {
  items: T[];
  total: number;
}

type TimeRange = "short_term" | "medium_term" | "long_term";

// Map user-friendly time range names to API values
function parseTimeRange(input: string | undefined): TimeRange {
  switch (input?.toLowerCase()) {
    case "short":
      return "short_term";
    case "long":
      return "long_term";
    case "medium":
    default:
      return "medium_term";
  }
}

// Parse args for top commands, extracting --clean flag and positional args
function parseTopArgs(args: string[]): {
  timeRange?: string;
  limit?: string;
  clean: boolean;
} {
  const clean = args.includes("--clean");
  const positional = args.filter((arg) => arg !== "--clean");
  return { timeRange: positional[0], limit: positional[1], clean };
}

// Get user's top artists
async function showTopArtists(args: string[]): Promise<void> {
  const {
    timeRange: timeRangeInput,
    limit: limitInput,
    clean,
  } = parseTopArgs(args);
  const timeRange = parseTimeRange(timeRangeInput);
  const limit = Math.min(50, Math.max(1, parseInt(limitInput || "5", 10) || 5));

  const response = await spotifyApiRequest<TopItemsResponse<TopArtist>>(
    "/me/top/artists",
    {
      params: { time_range: timeRange, limit: limit.toString() },
    },
  );

  if (!response.ok || !response.data) {
    cecho(`Failed to get top artists: ${response.status} ${response.error}`);
    return;
  }

  if (clean) {
    response.data.items.forEach((artist) => console.log(artist.name));
    return;
  }

  const timeRangeLabel =
    timeRange === "short_term"
      ? "last 4 weeks"
      : timeRange === "long_term"
        ? "all time"
        : "last 6 months";

  cecho(
    `Your top ${response.data.items.length} artists (${timeRangeLabel}):\n`,
  );

  response.data.items.forEach((artist, index) => {
    const genres = artist.genres.slice(0, 2).join(", ") || "No genres";
    console.log(`  ${index + 1}. ${artist.name}`);
    console.log(`     Genres: ${genres}`);
  });
}

// Get user's top tracks
async function showTopTracks(args: string[]): Promise<void> {
  const {
    timeRange: timeRangeInput,
    limit: limitInput,
    clean,
  } = parseTopArgs(args);
  const timeRange = parseTimeRange(timeRangeInput);
  const limit = Math.min(50, Math.max(1, parseInt(limitInput || "5", 10) || 5));

  const response = await spotifyApiRequest<TopItemsResponse<TopTrack>>(
    "/me/top/tracks",
    {
      params: { time_range: timeRange, limit: limit.toString() },
    },
  );

  if (!response.ok || !response.data) {
    cecho(`Failed to get top tracks: ${response.status} ${response.error}`);
    return;
  }

  if (clean) {
    response.data.items.forEach((track) => console.log(track.name));
    return;
  }

  const timeRangeLabel =
    timeRange === "short_term"
      ? "last 4 weeks"
      : timeRange === "long_term"
        ? "all time"
        : "last 6 months";

  cecho(`Your top ${response.data.items.length} tracks (${timeRangeLabel}):\n`);

  response.data.items.forEach((track, index) => {
    const artists = track.artists.map((a) => a.name).join(", ");
    console.log(`  ${index + 1}. ${track.name}`);
    console.log(`     by ${artists}`);
  });
}

// Color output
function cecho(message: string) {
  const bold = "\x1b[1m";
  const green = "\x1b[32m";
  const reset = "\x1b[0m";
  console.log(`${bold}${green}${message}${reset}`);
}

// Show help text
function showHelp() {
  console.log("\nUsage:\n");
  console.log("  spotify <command>\n");
  console.log("Commands:\n");
  console.log(
    "  login                        # Authenticate with your Spotify account.",
  );
  console.log(
    "  logout                       # Remove stored authentication tokens.",
  );
  console.log(
    "  search <query>               # Search for artists, tracks, albums, or playlists.",
  );
  console.log(
    "                               # Flags: --artists, --tracks, --albums, --playlist",
  );
  console.log(
    "  save                         # Save the current track to your library.",
  );
  console.log(
    "  follow                       # Follow the artist of the current track.",
  );
  console.log("  top-artists [range] [limit]  # Show your top artists.");
  console.log("  top-tracks [range] [limit]   # Show your top tracks.");
  console.log(
    "                               # range: short, medium (default), long",
  );
  console.log("                               # limit: 1-50 (default 5)");
  console.log(
    "                               # --clean: output names only (for piping)\n",
  );
  console.log(
    "  play                         # Resumes playback where Spotify last left off.",
  );
  console.log(
    "  play <song name>             # Finds a song by name and plays it.",
  );
  console.log(
    "  play album <album name>      # Finds an album by name and plays it.",
  );
  console.log(
    "  play artist <artist name>    # Finds an artist by name and plays it.",
  );
  console.log(
    "  play list <playlist name>    # Finds a playlist by name and plays it.",
  );
  console.log(
    "  play uri <uri>               # Play songs from specific uri.\n",
  );
  console.log(
    "  next                         # Skips to the next song in a playlist.",
  );
  console.log(
    "  prev                         # Returns to the previous song in a playlist.",
  );
  console.log(
    "  replay                       # Replays the current track from the beginning.",
  );
  console.log(
    "  pos <time>                   # Jumps to a time (in secs) in the current song.",
  );
  console.log(
    "  pause                        # Pauses (or resumes) Spotify playback.",
  );
  console.log("  stop                         # Stops playback.");
  console.log(
    "  quit                         # Stops playback and quits Spotify.\n",
  );
  console.log("  vol up                       # Increases the volume by 10%.");
  console.log("  vol down                     # Decreases the volume by 10%.");
  console.log(
    "  vol <amount>                 # Sets the volume to an amount between 0 and 100.",
  );
  console.log(
    "  vol [show]                   # Shows the current Spotify volume.\n",
  );
  console.log(
    "  status                       # Shows the current player status.",
  );
  console.log(
    "  status artist                # Shows the currently playing artist.",
  );
  console.log(
    "  status album                 # Shows the currently playing album.",
  );
  console.log(
    "  status track                 # Shows the currently playing track.\n",
  );
  console.log(
    "  share                        # Displays the current song's Spotify URL and URI.",
  );
  console.log(
    "  share url                    # Displays the current song's Spotify URL and copies it to the clipboard.",
  );
  console.log(
    "  share uri                    # Displays the current song's Spotify URI and copies it to the clipboard.\n",
  );
  console.log(
    "  toggle shuffle               # Toggles shuffle playback mode.",
  );
  console.log(
    "  toggle repeat                # Toggles repeat playback mode.\n",
  );
  showAPIHelp();
}

function showAPIHelp() {
  console.log("\nConnecting to Spotify's API:\n");
  console.log(
    "  This command line application needs to connect to Spotify's API in order to",
  );
  console.log(
    "  find music by name. It is very likely you want this feature!\n",
  );
  console.log(
    "  To get this to work, you need to sign up (or in) and create an 'Application' at:",
  );
  console.log(
    "  https://developer.spotify.com/my-applications/#!/applications/create\n",
  );
  console.log(
    "  Once you've created an application, find the 'Client ID' and 'Client Secret'",
  );
  console.log(
    `  values, and enter them into your shpotify config file at '${USER_CONFIG_FILE}'\n`,
  );
  console.log("  Be sure to quote your values and don't add any extra spaces!");
  console.log(
    "  When done, it should look like this (but with your own values):",
  );
  console.log('  CLIENT_ID="abc01de2fghijk345lmnop"');
  console.log('  CLIENT_SECRET="qr6stu789vwxyz"');
}

// OSA Script helpers
async function runOsascript(script: string): Promise<string> {
  try {
    const result = await bun.$`osascript -e '${script}'`.text();
    return result.trim();
  } catch (error) {
    console.error(error);
    return "";
  }
}

// Show current track info
async function showArtist(): Promise<string> {
  return await runOsascript(
    'tell application "Spotify" to artist of current track as string',
  );
}

async function showAlbum(): Promise<string> {
  return await runOsascript(
    'tell application "Spotify" to album of current track as string',
  );
}

async function showTrack(): Promise<string> {
  return await runOsascript(
    'tell application "Spotify" to name of current track as string',
  );
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

async function showStatus() {
  const state = await runOsascript(
    'tell application "Spotify" to player state as string',
  );
  cecho(`Spotify is currently ${state}.`);

  const duration = await runOsascript(`tell application "Spotify"
    set durSec to (duration of current track / 1000) as number
    return durSec
  end tell`);

  const position = await runOsascript(`tell application "Spotify"
    set pos to player position
    return pos
  end tell`);

  const artist = await showArtist();
  const album = await showAlbum();
  const track = await showTrack();

  console.log(`\nArtist: ${artist}`);
  console.log(`Album: ${album}`);
  console.log(`Track: ${track}`);
  console.log(
    `Position: ${formatTime(parseFloat(position))} / ${formatTime(parseFloat(duration))}`,
  );
}

// Spotify API functions
async function getAccessToken(): Promise<boolean> {
  if (!config.CLIENT_ID) {
    cecho(`Invalid Client ID, please update ${USER_CONFIG_FILE}`);
    showAPIHelp();
    return false;
  }

  if (!config.CLIENT_SECRET) {
    cecho(`Invalid Client Secret, please update ${USER_CONFIG_FILE}`);
    showAPIHelp();
    return false;
  }

  cecho("Connecting to Spotify's API");

  const credentials = Buffer.from(
    `${config.CLIENT_ID}:${config.CLIENT_SECRET}`,
  ).toString("base64");

  try {
    const response = await fetch(SPOTIFY_TOKEN_URI, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

    const data = (await response.json()) as SpotifyTokenResponse;

    if (!data.access_token) {
      cecho(`Authorization failed, please check ${USER_CONFIG_FILE}`);
      cecho(JSON.stringify(data));
      showAPIHelp();
      return false;
    }

    spotifyAccessToken = data.access_token;
    return true;
  } catch (error) {
    cecho(`Error getting access token: ${error}`);
    return false;
  }
}

async function searchSpotify(args: string[]): Promise<void> {
  const options = {
    artists: false,
    tracks: false,
    albums: false,
    playlists: false,
  };

  const queryParts: string[] = [];

  for (const arg of args) {
    if (arg === "--artists") options.artists = true;
    else if (arg === "--tracks") options.tracks = true;
    else if (arg === "--albums") options.albums = true;
    else if (arg === "--playlist") options.playlists = true;
    else queryParts.push(arg);
  }

  const query = queryParts.join(" ");
  if (!query) {
    cecho("Please provide a search query.");
    return;
  }

  // Default to all if no flags
  if (
    !options.artists &&
    !options.tracks &&
    !options.albums &&
    !options.playlists
  ) {
    options.artists = true;
    options.tracks = true;
    options.albums = true;
    options.playlists = true;
  }

  const types: string[] = [];
  if (options.artists) types.push("artist");
  if (options.tracks) types.push("track");
  if (options.albums) types.push("album");
  if (options.playlists) types.push("playlist");

  const response = await spotifyApiRequest<SpotifySearchResponse>("/search", {
    params: {
      q: query,
      type: types.join(","),
      limit: "5",
    },
  });

  if (!response.ok || !response.data) {
    cecho(`Failed to search: ${response.status} ${response.error}`);
    return;
  }

  const data = response.data;

  if (options.artists && data.artists?.items?.length) {
    cecho("\nArtists:");
    data.artists.items.forEach((item) => {
      const genres = item.genres?.slice(0, 2).join(", ");
      console.log(`  - ${item.name}${genres ? ` (${genres})` : ""}`);
    });
  }

  if (options.albums && data.albums?.items?.length) {
    cecho("\nAlbums:");
    data.albums.items.forEach((item) => {
      const artistName = item.artists?.[0]?.name || "Unknown Artist";
      console.log(`  - ${item.name} by ${artistName}`);
    });
  }

  if (options.tracks && data.tracks?.items?.length) {
    cecho("\nTracks:");
    data.tracks.items.forEach((item) => {
      const artistName = item.artists?.[0]?.name || "Unknown Artist";
      console.log(`  - ${item.name} by ${artistName} (${item.album.name})`);
    });
  }

  if (options.playlists && data.playlists?.items?.length) {
    cecho("\nPlaylists:");
    data.playlists.items.forEach((item) => {
      const owner = item.owner?.display_name || "Unknown Owner";
      console.log(`  - ${item.name} by ${owner}`);
    });
  }
  console.log(""); // Empty line at the end
}

async function searchAndPlay(type: string, query: string): Promise<string> {
  if (!(await getAccessToken())) {
    return "";
  }

  cecho(`Searching ${type}s for: ${query}`);

  try {
    const params = new URLSearchParams({
      q: query,
      type: type,
      limit: "1",
      offset: "0",
    });

    const response = await fetch(`${SPOTIFY_SEARCH_API}?${params}`, {
      headers: {
        Authorization: `Bearer ${spotifyAccessToken}`,
        Accept: "application/json",
      },
    });

    const data = (await response.json()) as SpotifySearchResponse;
    let uri = "";

    if (type === "playlist" && data.playlists?.items?.[0]) {
      uri = data.playlists.items[0].uri;
    } else if (type === "album" && data.albums?.items?.[0]) {
      uri = data.albums.items[0].uri;
    } else if (type === "artist" && data.artists?.items?.[0]) {
      uri = data.artists.items[0].uri;
    } else if (type === "track" && data.tracks?.items?.[0]) {
      uri = data.tracks.items[0].uri;
    }

    if (uri) {
      return uri;
    } else {
      cecho(`No results when searching for ${query}`);
      return "";
    }
  } catch (error) {
    cecho(`Error searching: ${error}`);
    return "";
  }
}

async function playUri(uri: string) {
  if (uri) {
    cecho(`Playing Spotify URI: ${uri}`);
    await runOsascript(`tell application "Spotify" to play track "${uri}"`);
  }
}

// Main command handlers
async function checkSpotifyRunning() {
  const isRunning = await runOsascript('application "Spotify" is running');
  return isRunning === "true";
}

async function ensureSpotifyRunning() {
  const isRunning = await checkSpotifyRunning();
  if (!isRunning) {
    await runOsascript('tell application "Spotify" to activate');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function main() {
  const args = Bun.argv.slice(2);

  if (args.length === 0) {
    showHelp();
    return;
  }

  const command = args[0];
  const rest = args.slice(1);

  // Handle login/logout commands separately (doesn't require Spotify app)
  if (command === "login") {
    await login();
    return;
  }

  if (command === "logout") {
    await logout();
    return;
  }

  if (command === "top-artists") {
    await showTopArtists(rest);
    return;
  }

  if (command === "top-tracks") {
    await showTopTracks(rest);
    return;
  }

  if (command === "search") {
    await searchSpotify(rest);
    return;
  }

  // Check if Spotify is installed (required for remaining commands)
  const spotifyAppPath1 = "/Applications/Spotify.app";
  const spotifyAppPath2 = join(homedir(), "Applications/Spotify.app");

  if (!fs.existsSync(spotifyAppPath1) && !fs.existsSync(spotifyAppPath2)) {
    console.log("The Spotify application must be installed.");
    process.exit(1);
  }

  await ensureSpotifyRunning();

  switch (command) {
    case "save":
      await saveCurrentTrack();
      break;

    case "follow":
      await followCurrentArtist();
      break;

    case "play": {
      if (args.length === 1) {
        cecho("Playing Spotify.");
        await runOsascript('tell application "Spotify" to play');
      } else {
        const subcommand = rest[0] || "";
        const searchQuery = rest
          .slice(subcommand === "uri" ? 0 : 1)
          .map((arg) => arg.replace("\\n", "").trim())
          .join(" ")
          .trim();
        let uri = "";
        if (subcommand === "uri") {
          uri = args.slice(2).join(" ");
          cecho(`Playing Spotify URI: ${uri}`);
        } else if (subcommand === "list") {
          uri = await searchAndPlay("playlist", searchQuery);
          if (uri) {
            cecho(`Playing (${searchQuery} Search) -> Spotify URI: ${uri}`);
          }
        } else if (["album", "artist", "track"].includes(subcommand)) {
          uri = await searchAndPlay(subcommand, searchQuery);
          if (uri) {
            cecho(`Playing (${searchQuery} Search) -> Spotify URI: ${uri}`);
          }
        } else {
          uri = await searchAndPlay("track", rest.join(" "));
          if (uri) {
            cecho(`Playing (${rest.join(" ")} Search) -> Spotify URI: ${uri}`);
          }
        }

        if (uri) {
          await playUri(uri);
        }
      }
      await showStatus();
      break;
    }

    case "pause":
      await runOsascript('tell application "Spotify" to playpause');
      await showStatus();
      break;

    case "stop": {
      const state = await runOsascript(
        'tell application "Spotify" to player state as string',
      );
      if (state === "playing") {
        cecho("Pausing Spotify.");
        await runOsascript('tell application "Spotify" to playpause');
      } else {
        cecho("Spotify is already stopped.");
      }
      break;
    }

    case "quit":
      cecho("Quitting Spotify.");
      await runOsascript('tell application "Spotify" to quit');
      process.exit(0);

    case "next":
      cecho("Going to next track.");
      await runOsascript('tell application "Spotify" to next track');
      await showStatus();
      break;

    case "prev":
      cecho("Going to previous track.");
      await runOsascript(`tell application "Spotify"
        set player position to 0
        previous track
      end tell`);
      await showStatus();
      break;

    case "replay":
      cecho("Replaying current track.");
      await runOsascript(
        'tell application "Spotify" to set player position to 0',
      );
      break;

    case "vol": {
      const volumeCmd = rest[0];

      if (!volumeCmd || volumeCmd === "show") {
        const vol = await runOsascript(
          'tell application "Spotify" to sound volume as integer',
        );
        cecho(`Current Spotify volume level is ${vol}.`);
      } else if (volumeCmd === "up") {
        const vol = parseInt(
          await runOsascript(
            'tell application "Spotify" to sound volume as integer',
          ),
        );
        const newVol = vol <= 90 ? vol + 10 : 100;
        cecho(
          vol <= 90
            ? `Increasing Spotify volume to ${newVol}.`
            : "Spotify volume level is at max.",
        );
        await runOsascript(
          `tell application "Spotify" to set sound volume to ${newVol}`,
        );
      } else if (volumeCmd === "down") {
        const vol = parseInt(
          await runOsascript(
            'tell application "Spotify" to sound volume as integer',
          ),
        );
        const newVol = vol >= 10 ? vol - 10 : 0;
        cecho(
          vol >= 10
            ? `Reducing Spotify volume to ${newVol}.`
            : "Spotify volume level is at min.",
        );
        await runOsascript(
          `tell application "Spotify" to set sound volume to ${newVol}`,
        );
      } else if (
        /^\d+$/.test(volumeCmd) &&
        parseInt(volumeCmd) >= 0 &&
        parseInt(volumeCmd) <= 100
      ) {
        cecho(`Setting Spotify volume level to ${volumeCmd}`);
        await runOsascript(
          `tell application "Spotify" to set sound volume to ${volumeCmd}`,
        );
      } else {
        console.log("Improper use of 'vol' command");
        console.log("The 'vol' command should be used as follows:");
        console.log(
          "  vol up                       # Increases the volume by 10%.",
        );
        console.log(
          "  vol down                     # Decreases the volume by 10%.",
        );
        console.log(
          "  vol [amount]                 # Sets the volume to an amount between 0 and 100.",
        );
        console.log(
          "  vol [show]                   # Shows the current Spotify volume.",
        );
        process.exit(1);
      }
      break;
    }

    case "toggle":
      if (rest[0] === "shuffle") {
        await runOsascript(
          'tell application "Spotify" to set shuffling to not shuffling',
        );
        const curr = await runOsascript(
          'tell application "Spotify" to shuffling',
        );
        cecho(`Spotify shuffling set to ${curr}`);
      } else if (rest[0] === "repeat") {
        await runOsascript(
          'tell application "Spotify" to set repeating to not repeating',
        );
        const curr = await runOsascript(
          'tell application "Spotify" to repeating',
        );
        cecho(`Spotify repeating set to ${curr}`);
      }
      break;

    case "status":
      if (rest.length === 0) {
        await showStatus();
      } else if (rest[0] === "artist") {
        const artist = await showArtist();
        console.log(artist);
      } else if (rest[0] === "album") {
        const album = await showAlbum();
        console.log(album);
      } else if (rest[0] === "track") {
        const track = await showTrack();
        console.log(track);
      }
      break;

    case "info": {
      const info = await runOsascript(`tell application "Spotify"
        set durSec to (duration of current track / 1000)
        set tM to (round (durSec / 60) rounding down) as text
        if length of ((durSec mod 60 div 1) as text) is greater than 1 then
          set tS to (durSec mod 60 div 1) as text
        else
          set tS to ("0" & (durSec mod 60 div 1)) as text
        end if
        set myTime to tM as text & "min " & tS as text & "s"
        set pos to player position
        set nM to (round (pos / 60) rounding down) as text
        if length of ((round (pos mod 60) rounding down) as text) is greater than 1 then
          set nS to (round (pos mod 60) rounding down) as text
        else
          set nS to ("0" & (round (pos mod 60) rounding down)) as text
        end if
        set nowAt to nM as text & "min " & nS as text & "s"
        set info to "" & "\\nArtist:         " & artist of current track
        set info to info & "\\nTrack:          " & name of current track
        set info to info & "\\nAlbum:          " & album of current track
        set info to info & "\\nDuration:       " & mytime
        set info to info & "\\nNow at:         " & nowAt
        set info to info & "\\nVolume:         " & sound volume
      end tell
      return info`);
      cecho(info);
      break;
    }

    case "share": {
      const uri = await runOsascript(
        'tell application "Spotify" to spotify url of current track',
      );
      const url = uri.replace(
        "spotify:track:",
        "https://open.spotify.com/track/",
      );

      if (!rest[0]) {
        cecho(`Spotify URL: ${url}`);
        cecho(`Spotify URI: ${uri}`);
        console.log("To copy the URL or URI to your clipboard, use:");
        console.log("`spotify share url` or");
        console.log("`spotify share uri` respectively.");
      } else if (rest[0] === "url") {
        cecho(`Spotify URL: ${url}`);
        await bun.$`echo -n ${url} | pbcopy`;
      } else if (rest[0] === "uri") {
        cecho(`Spotify URI: ${uri}`);
        await bun.$`echo -n ${uri} | pbcopy`;
      }
      break;
    }

    case "pos":
      cecho("Adjusting Spotify play position.");
      await runOsascript(
        `tell application "Spotify" to set player position to ${rest[0]}`,
      );
      break;

    case "help":
      showHelp();
      break;

    default:
      showHelp();
      process.exit(1);
  }
}

// Initialize and run
initializeConfig();
await main();
