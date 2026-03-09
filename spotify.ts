#!/usr/bin/env bun
import { homedir } from "os";
import { join } from "path";
// import * as fs from "fs";
import bun from "bun";

// Version - injected at build time via --define, defaults to "dev" for local development
declare const CLI_VERSION: string;
const VERSION = typeof CLI_VERSION !== "undefined" ? CLI_VERSION : "dev";
//////////////////////////////////////////////////////////////////////////////
// Configuration
//////////////////////////////////////////////////////////////////////////////
const USER_CONFIG_FILE = join(homedir(), ".shpotify.cfg");
const USER_CONFIG_DEFAULTS = 'CLIENT_ID=""\nCLIENT_SECRET=""';
const SPOTIFY_CLI_SERVICE = "spotify-cli";
const SPOTIFY_AUTH_URI = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URI = "https://accounts.spotify.com/api/token";
const SPOTIFY_SEARCH_API = "https://api.spotify.com/v1/search";
const OAUTH_REDIRECT_PORT = 8888;
const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_REDIRECT_PORT}/callback`;
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

interface Config {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
}
let config: Config = { CLIENT_ID: "", CLIENT_SECRET: "" };
let spotifyAccessToken: string = "";

// Initialize config file
async function initializeConfig() {
  const configFile = Bun.file(USER_CONFIG_FILE);
  if (!configFile.exists()) {
    await configFile.write(USER_CONFIG_DEFAULTS);
  }
  await loadConfig();
}

async function loadConfig() {
  try {
    const configFile = Bun.file(USER_CONFIG_FILE);
    const content = await configFile.text();
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

//////////////////////////////////////////////////////////////////////////////
// Spotify Token Management
//////////////////////////////////////////////////////////////////////////////
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

////////////////////////////////////////////////////////////////////////////////
// Login Flow
////////////////////////////////////////////////////////////////////////////////
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

//////////////////////////////////////////////////////////////////////////////
// Centralized Spotify API request function with auto re-auth
//////////////////////////////////////////////////////////////////////////////
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

  // Handle empty responses (204 No Content, or empty body)
  if (response.status === 204) {
    return { ok: true, status: 204 };
  }

  // Check content-length or try to parse JSON safely
  const contentLength = response.headers.get("content-length");
  if (contentLength === "0") {
    return { ok: true, status: response.status };
  }

  // Try to parse JSON, handle empty responses gracefully
  const text = await response.text();
  if (!text || text.trim() === "") {
    return { ok: true, status: response.status };
  }

  try {
    const data = JSON.parse(text) as T;
    return { ok: true, status: response.status, data };
  } catch {
    // If JSON parsing fails but response was ok, return success without data
    return { ok: true, status: response.status };
  }
}

// Types

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

////////////////////////////////////////////////////////////////////////////////
// Spotify Player Implementations
////////////////////////////////////////////////////////////////////////////////

// Player abstraction types
type RepeatMode = "off" | "track" | "context";

interface TrackInfo {
  id: string;
  uri: string;
  name: string;
  artist: string;
  album: string;
  durationMs: number;
}

interface PlayerState {
  isPlaying: boolean;
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;
  volume: number;
  positionMs: number;
  track: TrackInfo | null;
}

// SpotifyPlayer interface - abstraction for playback control
interface SpotifyPlayer {
  // State
  getPlayerState(): Promise<PlayerState>;
  getCurrentTrack(): Promise<TrackInfo | null>;

  // Playback control
  play(uri?: string): Promise<void>;
  pause(): Promise<void>;
  playPause(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  seek(positionMs: number): Promise<void>;

  // Volume
  getVolume(): Promise<number>;
  setVolume(volume: number): Promise<void>;

  // Modes
  setShuffle(enabled: boolean): Promise<void>;
  setRepeat(mode: RepeatMode): Promise<void>;
  getShuffleState(): Promise<boolean>;
  getRepeatState(): Promise<RepeatMode>;
}

// AppleScript player implementation - controls local Spotify app on macOS
class AppleScriptPlayer implements SpotifyPlayer {
  private async runOsascript(script: string): Promise<string> {
    try {
      const result = await bun.$`osascript -e '${script}'`.text();
      return result.trim();
    } catch (error) {
      console.error(error);
      return "";
    }
  }

  async getPlayerState(): Promise<PlayerState> {
    const script = `tell application "Spotify"
      set trackId to ""
      set trackUri to ""
      set trackName to ""
      set trackArtist to ""
      set trackAlbum to ""
      set trackDuration to 0
      try
        set trackUri to spotify url of current track
        set trackId to text 15 thru -1 of trackUri
        set trackName to name of current track
        set trackArtist to artist of current track
        set trackAlbum to album of current track
        set trackDuration to duration of current track
      end try
      set playerState to player state as string
      set isShuffling to shuffling
      set isRepeating to repeating
      set vol to sound volume
      set pos to player position
      return trackId & "|||" & trackUri & "|||" & trackName & "|||" & trackArtist & "|||" & trackAlbum & "|||" & trackDuration & "|||" & playerState & "|||" & isShuffling & "|||" & isRepeating & "|||" & vol & "|||" & pos
    end tell`;

    const result = await this.runOsascript(script);
    const parts = result.split("|||");

    const [
      trackId,
      trackUri,
      trackName,
      trackArtist,
      trackAlbum,
      trackDuration,
      playerState,
      shuffling,
      repeating,
      volume,
      position,
    ] = parts;

    const track: TrackInfo | null =
      trackId && trackUri
        ? {
            id: trackId || "",
            uri: trackUri || "",
            name: trackName || "",
            artist: trackArtist || "",
            album: trackAlbum || "",
            durationMs: parseInt(trackDuration || "0", 10),
          }
        : null;

    return {
      isPlaying: playerState === "playing",
      shuffleEnabled: shuffling === "true",
      repeatMode: repeating === "true" ? "context" : "off",
      volume: parseInt(volume || "0", 10),
      positionMs: Math.round(parseFloat(position || "0") * 1000),
      track,
    };
  }

  async getCurrentTrack(): Promise<TrackInfo | null> {
    const script = `tell application "Spotify"
      try
        set trackUri to spotify url of current track
        set trackId to text 15 thru -1 of trackUri
        set trackName to name of current track
        set trackArtist to artist of current track
        set trackAlbum to album of current track
        set trackDuration to duration of current track
        return trackId & "|||" & trackUri & "|||" & trackName & "|||" & trackArtist & "|||" & trackAlbum & "|||" & trackDuration
      on error
        return ""
      end try
    end tell`;

    const result = await this.runOsascript(script);
    if (!result) return null;

    const [
      trackId,
      trackUri,
      trackName,
      trackArtist,
      trackAlbum,
      trackDuration,
    ] = result.split("|||");

    return {
      id: trackId || "",
      uri: trackUri || "",
      name: trackName || "",
      artist: trackArtist || "",
      album: trackAlbum || "",
      durationMs: parseInt(trackDuration || "0", 10),
    };
  }

  async play(uri?: string): Promise<void> {
    if (uri) {
      await this.runOsascript(
        `tell application "Spotify" to play track "${uri}"`,
      );
    } else {
      await this.runOsascript('tell application "Spotify" to play');
    }
  }

  async pause(): Promise<void> {
    await this.runOsascript('tell application "Spotify" to pause');
  }

  async playPause(): Promise<void> {
    await this.runOsascript('tell application "Spotify" to playpause');
  }

  async next(): Promise<void> {
    await this.runOsascript('tell application "Spotify" to next track');
  }

  async previous(): Promise<void> {
    await this.runOsascript(`tell application "Spotify"
      set player position to 0
      previous track
    end tell`);
  }

  async seek(positionMs: number): Promise<void> {
    const positionSec = positionMs / 1000;
    await this.runOsascript(
      `tell application "Spotify" to set player position to ${positionSec}`,
    );
  }

  async getVolume(): Promise<number> {
    const result = await this.runOsascript(
      'tell application "Spotify" to sound volume as integer',
    );
    return parseInt(result || "0", 10);
  }

  async setVolume(volume: number): Promise<void> {
    const vol = Math.max(0, Math.min(100, volume));
    await this.runOsascript(
      `tell application "Spotify" to set sound volume to ${vol}`,
    );
  }

  async setShuffle(enabled: boolean): Promise<void> {
    await this.runOsascript(
      `tell application "Spotify" to set shuffling to ${enabled}`,
    );
  }

  async setRepeat(mode: RepeatMode): Promise<void> {
    // AppleScript only supports on/off for repeat, not track vs context
    const enabled = mode !== "off";
    await this.runOsascript(
      `tell application "Spotify" to set repeating to ${enabled}`,
    );
  }

  async getShuffleState(): Promise<boolean> {
    const result = await this.runOsascript(
      'tell application "Spotify" to shuffling',
    );
    return result === "true";
  }

  async getRepeatState(): Promise<RepeatMode> {
    const result = await this.runOsascript(
      'tell application "Spotify" to repeating',
    );
    // AppleScript only knows on/off, map to context/off
    return result === "true" ? "context" : "off";
  }
}

// Spotify API response types for player endpoints
interface SpotifyPlaybackState {
  is_playing: boolean;
  shuffle_state: boolean;
  repeat_state: "off" | "track" | "context";
  progress_ms: number;
  device?: { volume_percent: number };
  item?: {
    id: string;
    uri: string;
    name: string;
    duration_ms: number;
    artists: Array<{ name: string }>;
    album: { name: string };
  };
}

interface SpotifyCurrentlyPlaying {
  is_playing: boolean;
  progress_ms: number;
  item?: {
    id: string;
    uri: string;
    name: string;
    duration_ms: number;
    artists: Array<{ name: string }>;
    album: { name: string };
  };
}

// API player implementation - controls Spotify via Web API
class ApiPlayer implements SpotifyPlayer {
  async getPlayerState(): Promise<PlayerState> {
    const response =
      await spotifyApiRequest<SpotifyPlaybackState>("/me/player");

    if (!response.ok || !response.data) {
      // No active playback or error
      return {
        isPlaying: false,
        shuffleEnabled: false,
        repeatMode: "off",
        volume: 0,
        positionMs: 0,
        track: null,
      };
    }

    const data = response.data;
    const track: TrackInfo | null = data.item
      ? {
          id: data.item.id,
          uri: data.item.uri,
          name: data.item.name,
          artist: data.item.artists.map((a) => a.name).join(", "),
          album: data.item.album.name,
          durationMs: data.item.duration_ms,
        }
      : null;

    return {
      isPlaying: data.is_playing,
      shuffleEnabled: data.shuffle_state,
      repeatMode: data.repeat_state,
      volume: data.device?.volume_percent ?? 0,
      positionMs: data.progress_ms,
      track,
    };
  }

  async getCurrentTrack(): Promise<TrackInfo | null> {
    const response = await spotifyApiRequest<SpotifyCurrentlyPlaying>(
      "/me/player/currently-playing",
    );

    if (!response.ok || !response.data?.item) {
      return null;
    }

    const item = response.data.item;
    return {
      id: item.id,
      uri: item.uri,
      name: item.name,
      artist: item.artists.map((a) => a.name).join(", "),
      album: item.album.name,
      durationMs: item.duration_ms,
    };
  }

  async play(uri?: string): Promise<void> {
    const body = uri
      ? uri.includes(":track:")
        ? { uris: [uri] }
        : { context_uri: uri }
      : undefined;

    await spotifyApiRequest("/me/player/play", {
      method: "PUT",
      body,
    });
  }

  async pause(): Promise<void> {
    await spotifyApiRequest("/me/player/pause", { method: "PUT" });
  }

  async playPause(): Promise<void> {
    const state = await this.getPlayerState();
    if (state.isPlaying) {
      await this.pause();
    } else {
      await this.play();
    }
  }

  async next(): Promise<void> {
    await spotifyApiRequest("/me/player/next", { method: "POST" });
  }

  async previous(): Promise<void> {
    await spotifyApiRequest("/me/player/previous", { method: "POST" });
  }

  async seek(positionMs: number): Promise<void> {
    await spotifyApiRequest("/me/player/seek", {
      method: "PUT",
      params: { position_ms: positionMs.toString() },
    });
  }

  async getVolume(): Promise<number> {
    const state = await this.getPlayerState();
    return state.volume;
  }

  async setVolume(volume: number): Promise<void> {
    const vol = Math.max(0, Math.min(100, volume));
    await spotifyApiRequest("/me/player/volume", {
      method: "PUT",
      params: { volume_percent: vol.toString() },
    });
  }

  async setShuffle(enabled: boolean): Promise<void> {
    await spotifyApiRequest("/me/player/shuffle", {
      method: "PUT",
      params: { state: enabled.toString() },
    });
  }

  async setRepeat(mode: RepeatMode): Promise<void> {
    await spotifyApiRequest("/me/player/repeat", {
      method: "PUT",
      params: { state: mode },
    });
  }

  async getShuffleState(): Promise<boolean> {
    const state = await this.getPlayerState();
    return state.shuffleEnabled;
  }

  async getRepeatState(): Promise<RepeatMode> {
    const state = await this.getPlayerState();
    return state.repeatMode;
  }
}

// Player factory - selects appropriate implementation based on environment
type PlayerType = "applescript" | "api" | "auto";

async function createPlayer(
  preferredType: PlayerType = "auto",
): Promise<SpotifyPlayer> {
  // If explicitly requesting API, use it
  if (preferredType === "api") {
    return new ApiPlayer();
  }

  // If explicitly requesting AppleScript, use it (will fail on non-macOS)
  if (preferredType === "applescript") {
    return new AppleScriptPlayer();
  }

  // Auto-detect: prefer AppleScript on macOS if Spotify app is installed
  if (process.platform === "darwin") {
    const spotifyAppPath1 = "/Applications/Spotify.app";
    const spotifyAppPath2 = join(homedir(), "Applications/Spotify.app");

    const app1Exists = await Bun.file(spotifyAppPath1).exists();
    const app2Exists = await Bun.file(spotifyAppPath2).exists();

    if (app1Exists || app2Exists) {
      return new AppleScriptPlayer();
    }
  }

  // Fall back to API
  return new ApiPlayer();
}

// Get current track ID using player interface
async function getCurrentTrackIdWithPlayer(
  player: SpotifyPlayer,
): Promise<string | null> {
  const track = await player.getCurrentTrack();
  return track?.id ?? null;
}

// Legacy function for backward compatibility
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
async function saveCurrentTrackWithPlayer(
  player: SpotifyPlayer,
): Promise<void> {
  const track = await player.getCurrentTrack();

  if (!track) {
    cecho("No track is currently playing.");
    return;
  }
  // Save the track using new unified library endpoint
  const response = await spotifyApiRequest("/me/library", {
    method: "PUT",
    params: { uris: track.uri },
  });

  if (response.ok) {
    cecho(`Saved "${track.name}" by ${track.artist} to your library.`);
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

// Follow the artist of the current track using player interface
async function followCurrentArtistWithPlayer(
  player: SpotifyPlayer,
): Promise<void> {
  const track = await player.getCurrentTrack();

  if (!track) {
    cecho("No track is currently playing.");
    return;
  }

  // Get track details to get artist ID
  const trackDetails = await getTrackDetails(track.id);

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

  // Follow the artist using new unified library endpoint
  const response = await spotifyApiRequest("/me/library", {
    method: "PUT",
    params: { uris: `spotify:artist:${artist.id}` },
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
}

interface TopTrack {
  name: string;
  artists: Array<{ name: string }>;
  album: { name: string };
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
  console.log("Options:\n");
  console.log("  -v, --version                # Show version number.");
  console.log(
    "  --api                        # Force using Spotify Web API instead of local app.\n",
  );
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

// Show current track info - these legacy functions are kept for backward compatibility
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

function formatTimeMs(ms: number): string {
  return formatTime(ms / 1000);
}

// New showStatus using the player interface
async function showStatusWithPlayer(player: SpotifyPlayer) {
  const state = await player.getPlayerState();
  const statusText = state.isPlaying ? "playing" : "paused";
  cecho(`Spotify is currently ${statusText}.`);

  if (state.track) {
    console.log(`\nArtist: ${state.track.artist}`);
    console.log(`Album: ${state.track.album}`);
    console.log(`Track: ${state.track.name}`);
    console.log(
      `Position: ${formatTimeMs(state.positionMs)} / ${formatTimeMs(state.track.durationMs)}`,
    );
  } else {
    console.log("\nNo track currently playing.");
  }
}

// Legacy showStatus for backward compatibility
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

  // Check for --api flag to force API mode
  const useApi = args.includes("--api");
  const filteredRest = rest.filter((arg) => arg !== "--api");

  // Handle version flag
  if (command === "--version" || command === "-v") {
    console.log(`spotify-cli ${VERSION}`);
    return;
  }
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
    await showTopArtists(filteredRest);
    return;
  }

  if (command === "top-tracks") {
    await showTopTracks(filteredRest);
    return;
  }

  if (command === "search") {
    await searchSpotify(filteredRest);
    return;
  }

  // Create the player instance - use API if --api flag or AppleScript if available
  const player = await createPlayer(useApi ? "api" : "auto");
  const isAppleScript = player instanceof AppleScriptPlayer;

  // For AppleScript mode, ensure Spotify app is running
  if (isAppleScript) {
    const spotifyAppPath1 = "/Applications/Spotify.app";
    const spotifyAppPath2 = join(homedir(), "Applications/Spotify.app");

    const spotifyApp1 = Bun.file(spotifyAppPath1);
    const spotifyApp2 = Bun.file(spotifyAppPath2);
    if (!spotifyApp1.exists() && !spotifyApp2.exists()) {
      console.log("The Spotify application must be installed.");
      process.exit(1);
    }

    await ensureSpotifyRunning();
  }

  switch (command) {
    case "save":
      await saveCurrentTrackWithPlayer(player);
      break;

    case "follow":
      await followCurrentArtistWithPlayer(player);
      break;

    case "play": {
      if (args.length === 1 || (args.length === 2 && useApi)) {
        cecho("Playing Spotify.");
        await player.play();
      } else {
        const subcommand = filteredRest[0] || "";
        const searchQuery = filteredRest
          .slice(subcommand === "uri" ? 0 : 1)
          .map((arg) => arg.replace("\\n", "").trim())
          .join(" ")
          .trim();
        let uri = "";
        if (subcommand === "uri") {
          uri = args
            .filter((a) => a !== "--api")
            .slice(2)
            .join(" ");
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
          uri = await searchAndPlay("track", filteredRest.join(" "));
          if (uri) {
            cecho(
              `Playing (${filteredRest.join(" ")} Search) -> Spotify URI: ${uri}`,
            );
          }
        }

        if (uri) {
          await player.play(uri);
        }
      }
      await showStatusWithPlayer(player);
      break;
    }

    case "pause":
      await player.playPause();
      await showStatusWithPlayer(player);
      break;

    case "stop": {
      const state = await player.getPlayerState();
      if (state.isPlaying) {
        cecho("Pausing Spotify.");
        await player.pause();
      } else {
        cecho("Spotify is already stopped.");
      }
      break;
    }

    case "quit":
      // Quit only works with local Spotify app (AppleScript)
      if (!isAppleScript) {
        cecho(
          "The quit command is only available when controlling the local Spotify app.",
        );
        cecho(
          "Use --api flag to control playback via API, but quit requires the local app.",
        );
        process.exit(1);
      }
      cecho("Quitting Spotify.");
      await runOsascript('tell application "Spotify" to quit');
      process.exit(0);

    case "next":
      cecho("Going to next track.");
      await player.next();
      await showStatusWithPlayer(player);
      break;

    case "prev":
      cecho("Going to previous track.");
      await player.previous();
      await showStatusWithPlayer(player);
      break;

    case "replay":
      cecho("Replaying current track.");
      await player.seek(0);
      break;

    case "vol": {
      const volumeCmd = filteredRest[0];

      if (!volumeCmd || volumeCmd === "show") {
        const vol = await player.getVolume();
        cecho(`Current Spotify volume level is ${vol}.`);
      } else if (volumeCmd === "up") {
        const vol = await player.getVolume();
        const newVol = vol <= 90 ? vol + 10 : 100;
        cecho(
          vol <= 90
            ? `Increasing Spotify volume to ${newVol}.`
            : "Spotify volume level is at max.",
        );
        await player.setVolume(newVol);
      } else if (volumeCmd === "down") {
        const vol = await player.getVolume();
        const newVol = vol >= 10 ? vol - 10 : 0;
        cecho(
          vol >= 10
            ? `Reducing Spotify volume to ${newVol}.`
            : "Spotify volume level is at min.",
        );
        await player.setVolume(newVol);
      } else if (
        /^\d+$/.test(volumeCmd) &&
        parseInt(volumeCmd) >= 0 &&
        parseInt(volumeCmd) <= 100
      ) {
        cecho(`Setting Spotify volume level to ${volumeCmd}`);
        await player.setVolume(parseInt(volumeCmd));
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
      if (filteredRest[0] === "shuffle") {
        const currentShuffle = await player.getShuffleState();
        await player.setShuffle(!currentShuffle);
        cecho(`Spotify shuffling set to ${!currentShuffle}`);
      } else if (filteredRest[0] === "repeat") {
        const currentRepeat = await player.getRepeatState();
        const newRepeat = currentRepeat === "off" ? "context" : "off";
        await player.setRepeat(newRepeat);
        cecho(`Spotify repeating set to ${newRepeat !== "off"}`);
      }
      break;

    case "status":
      if (filteredRest.length === 0) {
        await showStatusWithPlayer(player);
      } else if (filteredRest[0] === "artist") {
        const track = await player.getCurrentTrack();
        console.log(track?.artist ?? "");
      } else if (filteredRest[0] === "album") {
        const track = await player.getCurrentTrack();
        console.log(track?.album ?? "");
      } else if (filteredRest[0] === "track") {
        const track = await player.getCurrentTrack();
        console.log(track?.name ?? "");
      }
      break;

    case "info": {
      const state = await player.getPlayerState();
      if (state.track) {
        const durationSec = state.track.durationMs / 1000;
        const positionSec = state.positionMs / 1000;
        console.log(`\nArtist:         ${state.track.artist}`);
        console.log(`Track:          ${state.track.name}`);
        console.log(`Album:          ${state.track.album}`);
        console.log(`Duration:       ${formatTime(durationSec)}`);
        console.log(`Now at:         ${formatTime(positionSec)}`);
        console.log(`Volume:         ${state.volume}`);
      } else {
        cecho("No track currently playing.");
      }
      break;
    }

    case "share": {
      const track = await player.getCurrentTrack();
      if (!track) {
        cecho("No track currently playing.");
        break;
      }
      const uri = track.uri;
      const url = uri.replace(
        "spotify:track:",
        "https://open.spotify.com/track/",
      );

      if (!filteredRest[0]) {
        cecho(`Spotify URL: ${url}`);
        cecho(`Spotify URI: ${uri}`);
        console.log("To copy the URL or URI to your clipboard, use:");
        console.log("`spotify share url` or");
        console.log("`spotify share uri` respectively.");
      } else if (filteredRest[0] === "url") {
        cecho(`Spotify URL: ${url}`);
        await bun.$`echo -n ${url} | pbcopy`;
      } else if (filteredRest[0] === "uri") {
        cecho(`Spotify URI: ${uri}`);
        await bun.$`echo -n ${uri} | pbcopy`;
      }
      break;
    }

    case "pos": {
      const positionSec = parseFloat(filteredRest[0] || "0");
      cecho("Adjusting Spotify play position.");
      await player.seek(positionSec * 1000);
      break;
    }

    case "help":
      showHelp();
      break;

    default:
      showHelp();
      process.exit(1);
  }
}

// Initialize and run
await initializeConfig();
await main();
