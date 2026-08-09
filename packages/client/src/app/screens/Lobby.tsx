import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { RoomInfo } from '@aerocade/shared';
import { appStore, useAppState } from '../store.js';
import { browseRooms, hostMatch, joinMatch } from '../../game/net/netplay.js';

/**
 * LAN lobby (docs/ui.md §7): host a room, or browse and join one.
 *
 * Both paths finish their network handshake **here**, before the game screen
 * mounts, and hand the game a ready `NetHandle`. That ordering is forced by the
 * renderer: a joining client's player slot only exists once the host's WELCOME
 * arrives, and the scene is built around knowing which soldier is yours.
 *
 * Errors are shown in place rather than throwing the player back to the menu —
 * "no bridge reachable" and "host did not answer" are the two most likely
 * outcomes on a strange network, and both need to be readable.
 */

/** Rooms are polled while the list is open (docs/networking.md §4). */
const POLL_MS = 2000;

export function Lobby({ mode }: { mode: 'host' | 'join' }): ReactElement {
  const mapId = useAppState((s) => s.mapId);
  const playerName = useAppState((s) => s.settings.playerName);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [busy, setBusy] = useState(mode === 'host');
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : 'connection failed');
    setBusy(false);
  }, []);

  // Host: create the room immediately. There is nothing to configure that the
  // menu has not already chosen, and an extra confirmation step would only delay
  // the room becoming visible to everyone else.
  useEffect(() => {
    if (mode !== 'host') return undefined;
    let cancelled = false;
    void hostMatch(mapId, playerName)
      .then((handle) => {
        if (cancelled) {
          handle.close();
          return;
        }
        appStore.startNetMatch(handle);
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [mode, mapId, playerName, fail]);

  // Join: poll the room list until the player picks one.
  useEffect(() => {
    if (mode !== 'join') return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = (): void => {
      void browseRooms()
        .then(({ rooms: found, close }) => {
          close();
          if (cancelled) return;
          setRooms(found);
          setError(null);
          timer = setTimeout(poll, POLL_MS);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          fail(e);
          timer = setTimeout(poll, POLL_MS);
        });
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [mode, fail]);

  const join = (room: RoomInfo): void => {
    setBusy(true);
    setError(null);
    void joinMatch(room, playerName)
      .then(({ handle }) => {
        appStore.startNetMatch(handle);
      })
      .catch(fail);
  };

  return (
    <div className="menu lobby">
      <h1>{mode === 'host' ? 'HOSTING' : 'JOIN A LAN MATCH'}</h1>

      {error !== null && (
        <div className="lobby-error" role="alert">
          {error}
          <div className="settings-note">
            The bridge is the device running <code>npx aerocade-lan</code>. If you did not open this
            page from it, add <code>?bridge=ip:port</code> to the URL.
          </div>
        </div>
      )}

      {mode === 'host' && error === null && <div className="hint">Opening a room…</div>}

      {mode === 'join' && (
        <>
          {busy && <div className="hint">Connecting…</div>}
          {!busy && rooms.length === 0 && error === null && (
            <div className="hint">No rooms yet — waiting for a host…</div>
          )}
          <div className="map-picker">
            {rooms.map((room) => (
              <button
                type="button"
                key={room.id}
                className="map-option"
                disabled={busy || room.players >= room.maxPlayers}
                onClick={() => {
                  join(room);
                }}
              >
                <span className="map-option-name">{room.name}</span>
                <span className="map-option-blurb">
                  {room.hostName} · {room.mapId} · {room.players}/{room.maxPlayers} players
                  {room.players >= room.maxPlayers ? ' · full' : ''}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      <button
        type="button"
        onClick={() => {
          appStore.setScreen('menu');
        }}
      >
        ← Back
      </button>
    </div>
  );
}
