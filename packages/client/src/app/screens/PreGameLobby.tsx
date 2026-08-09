import type { ReactElement } from 'react';
import { MatchPhase } from '@aerocade/shared';
import { useAppState, type LobbyPlayer } from '../store.js';

/**
 * The pre-game lobby: a live leaderboard of everyone in the room, held open until
 * the host starts the match.
 *
 * Deliberately **not** a countdown. A timer forces the host to guess how long
 * their friends need and starts without them if it guesses wrong; a Start button
 * lets the person who can see the room decide. Players appear the instant they
 * join, so the host can watch the room fill rather than wondering whether anyone
 * arrived.
 *
 * It renders over the live world (players can walk around while they wait), which
 * is why it is an overlay on the game screen rather than a menu screen — leaving
 * the lobby is a phase change in the simulation, not a route change.
 */

/** A stable colour per slot, so a player's chip is recognisable across screens. */
const SLOT_COLOURS = [
  '#6b7040',
  '#a8542c',
  '#4a6b8a',
  '#8a5a8a',
  '#8a8340',
  '#3f7a6a',
  '#a06a4a',
  '#5a5f8a',
];

function initial(name: string): string {
  const trimmed = name.trim();
  // `codePointAt` rather than `[0]`, so an emoji or an accented character does not
  // come back as half a surrogate pair.
  const point = trimmed.codePointAt(0);
  return point === undefined ? '?' : String.fromCodePoint(point).toUpperCase();
}

function Row({
  player,
  index,
  teams,
}: {
  player: LobbyPlayer;
  index: number;
  teams: boolean;
}): ReactElement {
  return (
    <li className={player.isLocal ? 'lobby-row is-you' : 'lobby-row'}>
      <span className="lobby-rank">{index + 1}</span>
      <span
        className="lobby-avatar"
        style={{ background: SLOT_COLOURS[player.slot % SLOT_COLOURS.length] }}
        aria-hidden="true"
      >
        {initial(player.name)}
      </span>
      <span className="lobby-name">
        {player.name}
        {player.isLocal && <span className="lobby-tag lobby-tag-you">you</span>}
        {player.isHost && <span className="lobby-tag lobby-tag-host">host</span>}
      </span>
      {teams && (
        <span className={`lobby-team team-${String(player.team)}`}>
          {player.team === 0 ? 'Olive' : 'Rust'}
        </span>
      )}
    </li>
  );
}

export function PreGameLobby(): ReactElement | null {
  const match = useAppState((s) => s.match);
  const players = useAppState((s) => s.lobbyPlayers);
  const canStart = useAppState((s) => s.canStartMatch);
  const net = useAppState((s) => s.net);

  if (match?.phase !== MatchPhase.Waiting) return null;

  const count = players.length;
  return (
    <div className="pregame" role="dialog" aria-label="Pre-game lobby">
      <div className="pregame-panel">
        <h2 className="pregame-title">LOBBY</h2>
        <div className="pregame-sub">
          {match.modeLabel}
          {match.fragLimit > 0 && ` · first to ${String(match.fragLimit)}`}
        </div>

        <ol className="lobby-list">
          {players.map((player, index) => (
            <Row key={player.slot} player={player} index={index} teams={match.teams} />
          ))}
        </ol>

        <div className="pregame-count">
          {count === 1 ? '1 player in the lobby' : `${String(count)} players in the lobby`}
        </div>

        {canStart ? (
          <button
            type="button"
            className="pregame-start"
            onClick={() => {
              net?.startMatch();
            }}
          >
            START GAME
          </button>
        ) : (
          <div className="pregame-waiting">Waiting for the host to start…</div>
        )}

        <div className="pregame-hint">
          Others can join from the bridge address while you wait — the lobby stays open.
        </div>
      </div>
    </div>
  );
}
