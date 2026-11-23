import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { useEventListener, useMKEventListener, useHapticFeedback } from "@/hooks";
import * as ConversionUtils from "@/utils/conversion";
import { spotifyApi, SpotifyApiError } from "@/utils/spotifyApi";

import {
  useMusicKit,
  useSettings,
  useSpotifySDK,
  VOLUME_KEY,
  ShuffleMode,
  RepeatMode,
} from "..";
import { IpodEvent } from "@/utils/events";

const defaultPlaybackInfoState = {
  isPlaying: false,
  isPaused: false,
  isLoading: false,
  currentTime: 0,
  timeRemaining: 0,
  percent: 0,
  duration: 0,
};

interface AudioPlayerState {
  playbackInfo: typeof defaultPlaybackInfoState;
  nowPlayingItem?: MediaApi.MediaItem;
  volume: number;
  shuffleMode: ShuffleMode;
  repeatMode: RepeatMode;
  play: (queueOptions: MediaApi.QueueOptions) => Promise<void>;
  pause: () => Promise<void>;
  seekToTime: (time: number) => Promise<void>;
  setVolume: (volume: number) => void;
  setShuffleMode: (mode: ShuffleMode) => Promise<void>;
  setRepeatMode: (mode: RepeatMode) => Promise<void>;
  skipNext: () => Promise<void>;
  skipPrevious: () => Promise<void>;
  togglePlayPause: () => Promise<void>;
  updateNowPlayingItem: () => Promise<void>;
  updatePlaybackInfo: () => Promise<void>;
  reset: () => void;
}

/**
 * Spotify SDK calls (nextTrack, getCurrentState, activateElement…) resolve via
 * postMessage from the SDK's iframe. If that iframe was suspended by iOS the
 * promise may never settle, so we never wait on them forever.
 */
const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);

/** Spotify answers these when the target device is gone or not ready yet. */
const isDeviceUnavailableError = (error: unknown) =>
  error instanceof SpotifyApiError &&
  (error.status === 404 || error.status === 502 || error.status === 503);

// Context initialized with empty object - actual value provided by AudioPlayerProvider
export const AudioPlayerContext = createContext<AudioPlayerState>(
  {} as AudioPlayerState
);

type AudioPlayerHook = AudioPlayerState;

export const useAudioPlayer = (): AudioPlayerHook => {
  const state = useContext(AudioPlayerContext);

  return state;
};

interface Props {
  children: React.ReactNode;
}

export const AudioPlayerProvider = ({ children }: Props) => {
  const {
    service,
    isSpotifyAuthorized,
    isAppleAuthorized,
    shuffleMode,
    repeatMode,
    setShuffleMode: updateShuffleModeSetting,
    setRepeatMode: updateRepeatModeSetting,
  } = useSettings();
  const {
    spotifyPlayer,
    accessToken,
    deviceId,
    refreshAccessToken,
    getFreshAccessToken,
    ensureDeviceReady,
  } = useSpotifySDK();
  const { music } = useMusicKit();
  const [volume, setVolume] = useState(0.5);
  const [nowPlayingItem, setNowPlayingItem] = useState<MediaApi.MediaItem>();
  const [playbackInfo, setPlaybackInfo] = useState(defaultPlaybackInfoState);

  const hasNowPlayingItem = !!nowPlayingItem;

  /** Shuffle state last reported by the Spotify player. */
  const spotifyShuffleStateRef = useRef<boolean | undefined>(undefined);
  /** Incremented per play request so stale requests don't clear the spinner. */
  const playRequestIdRef = useRef(0);

  const updateSpotifyPlayerState = useCallback(
    async (endpoint: string) => {
      if (!accessToken) return;
      await spotifyApi({
        endpoint: `me/player/${endpoint}`,
        method: "PUT",
        accessToken,
        onTokenExpired: refreshAccessToken,
      });
    },
    [accessToken, refreshAccessToken]
  );

  const playAppleMusic = useCallback(
    async (queueOptions: MediaApi.QueueOptions) => {
      if (!isAppleAuthorized) {
        throw new Error("Unable to play: Not authorized");
      }

      // MusicKit JS V3 doesn't support passing a single playlist id to the queue.
      // Workaround: extract the song ids instead.
      const playlistSongs = queueOptions.playlist?.songs?.map(({ id }) => id);

      // When startPosition is provided with an album, MusicKit ignores it.
      // Workaround: pass the album's songs as individual song IDs.
      const albumSongs = queueOptions.album?.songs?.map((song) => song.id);

      // MusicKit JS V3 expects only a single media type with no empty keys.
      const queue: Partial<MusicKit.SetQueueOptions> = {};

      if (albumSongs) {
        queue.songs = albumSongs;
      } else if (queueOptions.album?.id) {
        queue.album = queueOptions.album.id;
      } else if (playlistSongs) {
        queue.songs = playlistSongs;
      } else if (queueOptions.songs) {
        queue.songs = queueOptions.songs.map((song) => song.url);
      } else if (queueOptions.song?.id) {
        queue.song = queueOptions.song.id;
      }

      await music.setQueue(queue);

      // Jump to the selected track if needed (MusicKit defaults to index 0)
      if (queueOptions.startPosition) {
        await music.changeToMediaAtIndex(queueOptions.startPosition);
      }

      // Only call play() if not already playing (changeToMediaAtIndex may auto-start playback)
      if (!music.isPlaying) {
        await music.play();
      }
    },
    [isAppleAuthorized, music]
  );

  const playSpotify = useCallback(
    async (queueOptions: MediaApi.QueueOptions) => {
      if (!isSpotifyAuthorized) {
        throw new Error("Unable to play: Not authorized");
      }

      // Safari on iOS requires a user interaction to activate the player.
      // This must be *called* synchronously inside the click, but we must not
      // block on it: its promise can hang if the SDK iframe was suspended.
      // This function exists in the Spotify SDK, but is not present in the types.
      if (spotifyPlayer && "activateElement" in spotifyPlayer) {
        const activation = (
          spotifyPlayer as Spotify.Player & {
            activateElement: () => Promise<void>;
          }
        )
          .activateElement()
          .catch((error) => {
            console.warn("[spotify] activateElement failed:", error);
          });
        await withTimeout(activation, 1000);
      }

      // Spotify only accepts a list of song URIs, so we'll look through each media type provided for songs.
      const uris = [
        ...(queueOptions.album?.songs?.map((song) => song.url) ?? []),
        ...(queueOptions.playlist?.songs?.map((song) => song.url) ?? []),
        ...(queueOptions.songs?.map((song) => song.url) ?? []),
        queueOptions.song?.url,
      ].filter((uri): uri is string => !!uri);

      const requestId = ++playRequestIdRef.current;

      setPlaybackInfo((prevState) => ({
        ...prevState,
        isLoading: true,
      }));

      try {
        const body: { uris: string[]; offset?: { position: number } } = {
          uris,
        };

        if (queueOptions.startPosition !== undefined) {
          body.offset = { position: queueOptions.startPosition };
        }

        const sendPlay = async (targetDeviceId: string | undefined) => {
          const token = (await getFreshAccessToken()) ?? accessToken;
          if (!token) {
            throw new Error("Unable to play: missing Spotify access token");
          }
          if (!targetDeviceId) {
            throw new Error("Unable to play: Spotify player is not connected");
          }

          await spotifyApi({
            endpoint: `me/player/play`,
            method: "PUT",
            params: { device_id: targetDeviceId },
            body,
            accessToken: token,
            onTokenExpired: refreshAccessToken,
          });

          return { token, targetDeviceId };
        };

        // The device can silently go offline while the app is in the
        // background. Make sure it's registered before sending playback.
        let result: { token: string; targetDeviceId: string };
        try {
          result = await sendPlay((await ensureDeviceReady()) ?? deviceId);
        } catch (error) {
          if (!isDeviceUnavailableError(error)) throw error;

          // "Device not found": Spotify dropped our device. Reconnect and retry once.
          console.warn("[spotify] Device unavailable, reconnecting…", error);
          result = await sendPlay(await ensureDeviceReady({ force: true }));
        }

        // Only change shuffle *after* the new queue is playing, and only if
        // it actually differs. Toggling it concurrently with `play` makes
        // Spotify reshuffle the queue mid-load, which can cut off or switch
        // the track that just started.
        const shouldShuffle = shuffleMode !== "off";
        if (spotifyShuffleStateRef.current !== shouldShuffle) {
          try {
            await spotifyApi({
              endpoint: `me/player/shuffle`,
              method: "PUT",
              params: {
                state: shouldShuffle,
                device_id: result.targetDeviceId,
              },
              accessToken: result.token,
              onTokenExpired: refreshAccessToken,
            });
            spotifyShuffleStateRef.current = shouldShuffle;
          } catch (error) {
            // Shuffle is best-effort; don't fail playback
            console.warn("[spotify] Unable to set shuffle:", error);
          }
        }
      } finally {
        if (requestId === playRequestIdRef.current) {
          setPlaybackInfo((prevState) => ({
            ...prevState,
            isLoading: false,
          }));
        }
      }
    },
    [
      accessToken,
      deviceId,
      ensureDeviceReady,
      getFreshAccessToken,
      isSpotifyAuthorized,
      refreshAccessToken,
      shuffleMode,
      spotifyPlayer,
    ]
  );

  const play = useCallback(
    async (queueOptions: MediaApi.QueueOptions) => {
      switch (service) {
        case "apple":
          await playAppleMusic(queueOptions);
          break;
        case "spotify":
          await playSpotify(queueOptions);
          break;
        default:
          throw new Error("Unable to play: service not specified");
      }
    },
    [playAppleMusic, playSpotify, service]
  );

  const pause = useCallback(async () => {
    switch (service) {
      case "apple":
        return music.pause();
      case "spotify":
        return spotifyPlayer?.pause();
      default:
        throw new Error("Unable to pause: no service specified");
    }
  }, [music, service, spotifyPlayer]);

  const togglePlayPause = useCallback(async () => {
    if (!hasNowPlayingItem) {
      return;
    }

    switch (service) {
      case "apple":
        if (music.isPlaying) {
          music.pause();
        } else {
          music.play();
        }
        break;
      case "spotify":
        spotifyPlayer?.togglePlay();
        break;
      default:
        throw new Error("Unable to toggle play/pause: no service specified");
    }
  }, [hasNowPlayingItem, music, service, spotifyPlayer]);

  const skipNext = useCallback(async () => {
    if (!nowPlayingItem) {
      return;
    }

    setPlaybackInfo((prevState) => ({
      ...prevState,
      isLoading: true,
    }));

    try {
      switch (service) {
        case "apple":
          if (music.nowPlayingItem) {
            await music.skipToNextItem();
          }
          break;
        case "spotify":
          if (spotifyPlayer) {
            await withTimeout(spotifyPlayer.nextTrack(), 5000);
          }
          break;
        default:
          throw new Error("Unable to skip next: no service specified");
      }
    } finally {
      setPlaybackInfo((prevState) => ({
        ...prevState,
        isLoading: false,
      }));
    }
  }, [music, nowPlayingItem, service, spotifyPlayer]);

  const skipPrevious = useCallback(async () => {
    if (!nowPlayingItem) {
      return;
    }

    setPlaybackInfo((prevState) => ({
      ...prevState,
      isLoading: true,
    }));

    try {
      switch (service) {
        case "apple":
          if (music.nowPlayingItem) {
            await music.skipToPreviousItem();
          }
          break;
        case "spotify":
          if (spotifyPlayer) {
            await withTimeout(spotifyPlayer.previousTrack(), 5000);
          }
          break;
        default:
          throw new Error("Unable to skip previous: no service specified");
      }
    } finally {
      setPlaybackInfo((prevState) => ({
        ...prevState,
        isLoading: false,
      }));
    }
  }, [music, nowPlayingItem, service, spotifyPlayer]);

  const updateNowPlayingItem = useCallback(async () => {
    let mediaItem: MediaApi.MediaItem | undefined;

    if (service === "apple" && music.nowPlayingItem) {
      mediaItem = ConversionUtils.convertAppleMediaItem(music.nowPlayingItem);
    } else if (service === "spotify") {
      const state = spotifyPlayer
        ? await withTimeout(spotifyPlayer.getCurrentState(), 3000)
        : undefined;

      if (state) {
        mediaItem = ConversionUtils.convertSpotifyMediaItem(state);
      }
    }

    setNowPlayingItem(mediaItem);
  }, [music, service, spotifyPlayer]);

  const handleApplePlaybackStateChange = useCallback(
    ({ state }: { state: MusicKit.PlaybackStates }) => {
      let isLoading = false;
      let isPlaying = false;
      let isPaused = false;

      switch (state) {
        case MusicKit.PlaybackStates.playing:
          isPlaying = true;
          break;
        case MusicKit.PlaybackStates.paused:
          isPaused = true;
          break;
        case MusicKit.PlaybackStates.loading:
        case MusicKit.PlaybackStates.waiting:
        case MusicKit.PlaybackStates.stalled:
          isLoading = true;
          break;
      }

      setPlaybackInfo((prevState) => ({
        ...prevState,
        isPlaying,
        isPaused,
        isLoading,
      }));

      updateNowPlayingItem();
    },
    [updateNowPlayingItem]
  );

  const handleSpotifyPlaybackStateChange = useCallback(
    (state?: Spotify.PlaybackState) => {
      if (!state) {
        return;
      }

      spotifyShuffleStateRef.current = state.shuffle;

      setPlaybackInfo((prevState) => ({
        ...prevState,
        isPlaying: !state.paused,
        isPaused: state.paused,
        isLoading: false,
      }));

      updateNowPlayingItem();
    },
    [updateNowPlayingItem]
  );

  const updatePlaybackInfo = useCallback(async () => {
    if (service === "apple") {
      setPlaybackInfo((prevState) => ({
        ...prevState,
        currentTime: music.currentPlaybackTime,
        timeRemaining: music.currentPlaybackTimeRemaining,
        percent: music.currentPlaybackProgress * 100,
        duration: music.currentPlaybackDuration,
      }));
    } else if (service === "spotify") {
      const { position, duration } =
        (spotifyPlayer
          ? await withTimeout(spotifyPlayer.getCurrentState(), 3000)
          : undefined) ?? {};
      const currentTime = (position ?? 0) / 1000;
      const maxTime = (duration ?? 0) / 1000;
      const timeRemaining = maxTime - currentTime;
      const percent =
        maxTime > 0 ? Math.round((currentTime / maxTime) * 100) : 0;

      setPlaybackInfo((prevState) => ({
        ...prevState,
        currentTime,
        timeRemaining,
        percent,
        duration: maxTime,
      }));
    }
  }, [music, service, spotifyPlayer]);

  const seekToTime = useCallback(
    async (time: number) => {
      if (service === "apple") {
        await music.seekToTime(time);
      } else if (service === "spotify") {
        // Seek to time (in ms)
        await spotifyPlayer?.seek(time * 1000);
      }

      updatePlaybackInfo();
    },
    [music, service, spotifyPlayer, updatePlaybackInfo]
  );

  const handleChangeVolume = useCallback(
    (newVolume: number) => {
      if (isSpotifyAuthorized) {
        spotifyPlayer?.setVolume(newVolume);
      }

      if (isAppleAuthorized) {
        music.volume = newVolume;
      }

      localStorage.setItem(VOLUME_KEY, `${newVolume}`);

      setVolume(newVolume);
    },
    [isAppleAuthorized, isSpotifyAuthorized, music, spotifyPlayer]
  );

  const reset = useCallback(() => {
    // Stop any current playback
    if (service === "apple") {
      music.stop();
    } else if (service === "spotify") {
      spotifyPlayer?.pause();
    }

    // Reset all state
    setNowPlayingItem(undefined);
    setPlaybackInfo(defaultPlaybackInfoState);
  }, [music, service, spotifyPlayer]);

  const handleSetShuffleMode = useCallback(
    async (mode: ShuffleMode) => {
      updateShuffleModeSetting(mode);

      if (service === "apple") {
        music.shuffleMode =
          mode === "off"
            ? MusicKit.PlayerShuffleMode.off
            : MusicKit.PlayerShuffleMode.songs;
      } else if (service === "spotify") {
        const enabled = mode !== "off";
        await updateSpotifyPlayerState(
          `shuffle?state=${enabled}&device_id=${deviceId}`
        );
        spotifyShuffleStateRef.current = enabled;
      }
    },
    [
      service,
      music,
      deviceId,
      updateShuffleModeSetting,
      updateSpotifyPlayerState,
    ]
  );

  const handleSetRepeatMode = useCallback(
    async (mode: RepeatMode) => {
      updateRepeatModeSetting(mode);

      if (service === "apple") {
        const modeMap = {
          off: MusicKit.PlayerRepeatMode.none,
          one: MusicKit.PlayerRepeatMode.one,
          all: MusicKit.PlayerRepeatMode.all,
        } as const;
        music.repeatMode = modeMap[mode];
      } else if (service === "spotify") {
        const stateMap = { off: "off", one: "track", all: "context" } as const;
        await updateSpotifyPlayerState(
          `repeat?state=${stateMap[mode]}&device_id=${deviceId}`
        );
      }
    },
    [
      service,
      music,
      deviceId,
      updateRepeatModeSetting,
      updateSpotifyPlayerState,
    ]
  );

  const { triggerHaptics } = useHapticFeedback();

  const handlePlayPauseClick = useCallback(() => {
    triggerHaptics();
    togglePlayPause();
  }, [togglePlayPause, triggerHaptics]);

  const handleSkipNext = useCallback(() => {
    triggerHaptics();
    skipNext();
  }, [skipNext, triggerHaptics]);

  const handleSkipPrevious = useCallback(() => {
    triggerHaptics();
    skipPrevious();
  }, [skipPrevious, triggerHaptics]);

  useEventListener<IpodEvent>("playpauseclick", handlePlayPauseClick);
  useEventListener<IpodEvent>("forwardclick", handleSkipNext);
  useEventListener<IpodEvent>("backwardclick", handleSkipPrevious);

  // Apple playback event listeners
  useMKEventListener("playbackStateDidChange", handleApplePlaybackStateChange);
  useMKEventListener("queuePositionDidChange", updateNowPlayingItem);

  useEffect(() => {
    if (isSpotifyAuthorized && spotifyPlayer) {
      spotifyPlayer.addListener(
        "player_state_changed",
        handleSpotifyPlaybackStateChange
      );

      return () =>
        spotifyPlayer.removeListener(
          "player_state_changed",
          handleSpotifyPlaybackStateChange
        );
    }
  }, [handleSpotifyPlaybackStateChange, isSpotifyAuthorized, spotifyPlayer]);

  // Initialize volume when either service is authorized
  useEffect(() => {
    if (isAppleAuthorized || isSpotifyAuthorized) {
      const savedVolume = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "0.5");
      handleChangeVolume(savedVolume);
    }
  }, [handleChangeVolume, isAppleAuthorized, isSpotifyAuthorized]);

  return (
    <AudioPlayerContext.Provider
      value={{
        playbackInfo,
        nowPlayingItem,
        volume,
        shuffleMode,
        repeatMode,
        play,
        pause,
        seekToTime,
        setVolume: handleChangeVolume,
        setShuffleMode: handleSetShuffleMode,
        setRepeatMode: handleSetRepeatMode,
        togglePlayPause,
        updateNowPlayingItem,
        updatePlaybackInfo,
        skipNext,
        skipPrevious,
        reset,
      }}
    >
      {children}
    </AudioPlayerContext.Provider>
  );
};

export default useAudioPlayer;
