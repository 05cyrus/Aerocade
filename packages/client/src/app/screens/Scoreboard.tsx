import type { ReactElement } from 'react';
import { MatchPhase, NO_WINNER } from '@aerocade/shared';
import { appStore, useAppState, type Standing } from '../store.js';

/**
 * Standings, shown while the scoreboard key is held and permanently once the
 * match is decided.
 *
 * The same panel serves both because they are the same information — a player
 * checking the score mid-match and a player reading the final result want one
 * table, not two that could disagree. The end-of-match version just adds the
 * result line and the way out.
 *
 * Rows arrive pre-sorted from the session: sorting in the sim's own terms (frags,
 * then fewest deaths) keeps the order identical on every client, which matters
 * because two players comparing screens is exactly how "the scoreboard is wrong"
 * gets reported.
 */

function resultLine(winner: number, youWon: boolean, standings: readonly Standing[]): string {
  if (winner === NO_WINNER) return 'DRAW';
  if (youWon) return 'VICTORY';
  const name = standings.find((row) => row.entrant === winner)?.name;
  return name === undefined ? 'MATCH OVER' : `${name.toUpperCase()} WINS`;
}

export function Scoreboard(): ReactElement | null {
  const match = useAppState((s) => s.match);
  const standings = useAppState((s) => s.standings);
  const held = useAppState((s) => s.scoreboardOpen);
  const net = useAppState((s) => s.net);

  if (match === null) return null;
  const over = match.phase === MatchPhase.Over;
  if (!over && !held) return null;

  return (
    <div className={over ? 'scoreboard scoreboard-final' : 'scoreboard'} role="status">
      {over && (
        <div className="scoreboard-result">{resultLine(match.winner, match.youWon, standings)}</div>
      )}
      <div className="scoreboard-mode">
        {match.modeLabel}
        {match.fragLimit > 0 && ` · first to ${String(match.fragLimit)}`}
      </div>

      <table className="scoreboard-table">
        <thead>
          <tr>
            <th className="col-name">{match.teams ? 'Team' : 'Player'}</th>
            <th>Score</th>
            <th>Frags</th>
            <th>Deaths</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((row) => (
            <tr
              key={row.entrant}
              className={
                (row.isLocal ? 'is-local ' : '') + (row.entrant === match.winner ? 'is-winner' : '')
              }
            >
              <td className="col-name">
                {match.teams && <span className={`team-dot team-${String(row.team)}`} />}
                {row.name}
              </td>
              <td>{row.score}</td>
              <td>{row.frags}</td>
              <td>{row.deaths}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {over && (
        <button
          type="button"
          className="scoreboard-exit"
          onClick={() => {
            // A networked match must release its bridge socket; the sandbox only
            // has a screen to leave.
            if (net !== null) appStore.endNetMatch();
            else appStore.setScreen('menu');
          }}
        >
          Back to menu
        </button>
      )}
    </div>
  );
}
