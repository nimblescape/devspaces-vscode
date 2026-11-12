// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The GIF of a take of record.mjs, in the style of the GIFs of nimblescape PlantUML, Mindbug and Comment Links: the
// window of 1440 x 816 pixels below a band of 53 pixels in the blue of VS Code (#0078d4), with "<scene>/<scenes>  <caption>"
// in white Inter SemiBold 23, centered; 15 frames per second, one palette of 256 colors, no dithering. The parts of the
// take in `marks.cuts` (a wait) are left out.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The file of the font Inter in `style`. */
function inter(style) {
  return execFileSync('fc-match', ['-f', '%{file}', `Inter:style=${style}`]).toString().trim();
}

/**
 * Writes the GIF `gif` of the video `video` (20 frames per second) with the marks of its take: `scenes` (the number
 * `n` of each scene and its start `at`) and `cuts` (`from`, `to`), all in ms of the video. `captions[n - 1]` is the
 * caption of scene `n`. Returns the file, its size, and its length and the length of the take in seconds.
 */
export function writeGif(video, marks, captions, gif) {
  const cuts = marks.cuts.map((cut) => ({ from: cut.from / 1000, to: cut.to / 1000 }));
  // A time of the take in the GIF: less the cut parts before it.
  const shift = (t) => t - cuts.reduce((sum, cut) => sum + Math.max(0, Math.min(t, cut.to) - cut.from), 0);
  const takeSeconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString());
  const texts = path.join(path.dirname(gif), 'texts');
  fs.mkdirSync(texts, { recursive: true });
  const semibold = inter('SemiBold');
  const filters = [];
  if (cuts.length > 0) filters.push(`select='${cuts.map((cut) => `not(between(t,${cut.from.toFixed(3)},${cut.to.toFixed(3)}))`).join('*')}'`, 'setpts=N/20/TB');
  filters.push('pad=iw:ih+53:0:53:color=0x0078d4');
  marks.scenes.forEach((scene, index) => {
    const file = path.join(texts, `band-${scene.n}.txt`);
    fs.writeFileSync(file, `${scene.n}/${captions.length}  ${captions[scene.n - 1]}`);
    const from = index === 0 ? 0 : shift(scene.at / 1000);
    const to = index + 1 < marks.scenes.length ? shift(marks.scenes[index + 1].at / 1000) : shift(takeSeconds) + 1;
    filters.push(`drawtext=fontfile='${semibold}':textfile='${file}':expansion=none:fontsize=23:fontcolor=white:x=(w-text_w)/2:y=(53-text_h)/2:enable='gte(t,${from.toFixed(3)})*lt(t,${to.toFixed(3)})'`);
  });
  const graph = `${[...filters, 'fps=15'].join(',')},split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-filter_complex', graph, gif], { stdio: 'inherit' });
  return { file: gif, bytes: fs.statSync(gif).size, seconds: shift(takeSeconds), takeSeconds };
}
