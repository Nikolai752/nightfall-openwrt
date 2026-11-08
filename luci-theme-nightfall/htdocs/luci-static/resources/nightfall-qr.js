'use strict';
'require baseclass';

/* Мини-кодировщик QR: байтовый режим, коррекция M, версии 1–10 (до 213 байт). Возвращает матрицу [строки][столбцы] из 0/1. */
function nfQr(text) {
	const data = Array.from(new TextEncoder().encode(text));
	/* [ECC на блок, блоков в группе 1, данных в блоке 1, блоков в группе 2, данных в блоке 2] */
	const V = [ null, [ 10, 1, 16, 0, 0 ], [ 16, 1, 28, 0, 0 ], [ 26, 1, 44, 0, 0 ], [ 18, 2, 32, 0, 0 ], [ 24, 2, 43, 0, 0 ], [ 16, 4, 27, 0, 0 ], [ 18, 4, 31, 0, 0 ], [ 22, 2, 38, 2, 39 ], [ 22, 3, 36, 2, 37 ], [ 26, 4, 43, 1, 44 ] ];
	const AL = [ null, [], [ 6, 18 ], [ 6, 22 ], [ 6, 26 ], [ 6, 30 ], [ 6, 34 ], [ 6, 22, 38 ], [ 6, 24, 42 ], [ 6, 26, 46 ], [ 6, 28, 50 ] ];
	const cap = v => V[v][1] * V[v][2] + V[v][3] * V[v][4];
	let ver = 0;
	for (let v = 1; v <= 10; v++) if (data.length + 2 + (v >= 10 ? 1 : 0) <= cap(v)) { ver = v; break; }
	if (!ver) return null;
	const total = cap(ver);
	/* биты данных */
	const bits = [];
	const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
	put(4, 4); put(data.length, ver >= 10 ? 16 : 8); data.forEach(b => put(b, 8));
	put(0, Math.min(4, total * 8 - bits.length)); while (bits.length % 8) bits.push(0);
	const cw = []; for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; cw.push(b); }
	for (let p = 0; cw.length < total; p ^= 1) cw.push(p ? 0x11 : 0xEC);
	/* Рид-Соломон */
	const exp = new Array(512), log = new Array(256);
	for (let i = 0, x = 1; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
	for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
	const mul = (a, b) => (a && b) ? exp[log[a] + log[b]] : 0;
	const [ ecn, b1, d1, b2, d2 ] = V[ver];
	let gen = [ 1 ];
	for (let i = 0; i < ecn; i++) { const g = new Array(gen.length + 1).fill(0); for (let j = 0; j < gen.length; j++) { g[j] ^= gen[j]; g[j + 1] ^= mul(gen[j], exp[i]); } gen = g; }
	const blocks = []; let pos = 0;
	for (let i = 0; i < b1 + b2; i++) {
		const n = i < b1 ? d1 : d2, d = cw.slice(pos, pos + n); pos += n;
		const r = d.concat(new Array(ecn).fill(0));
		for (let j = 0; j < n; j++) { const c = r[j]; if (c) for (let k = 0; k < gen.length; k++) r[j + k] ^= mul(gen[k], c); }
		blocks.push({ d, e: r.slice(n) });
	}
	const out = [];
	for (let i = 0; i < Math.max(d1, d2); i++) blocks.forEach(b => { if (i < b.d.length) out.push(b.d[i]); });
	for (let i = 0; i < ecn; i++) blocks.forEach(b => out.push(b.e[i]));
	/* матрица */
	const N = 17 + 4 * ver, M = [], R = [];
	for (let i = 0; i < N; i++) { M.push(new Array(N).fill(0)); R.push(new Array(N).fill(false)); }
	const set = (r, c, v) => { if (r >= 0 && c >= 0 && r < N && c < N) { M[r][c] = v ? 1 : 0; R[r][c] = true; } };
	const finder = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) set(r + i, c + j, i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4))); };
	finder(0, 0); finder(0, N - 7); finder(N - 7, 0);
	for (let i = 8; i < N - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
	const ap = AL[ver];
	ap.forEach((r, a) => ap.forEach((c, b) => {
		if ((a === 0 && b === 0) || (a === 0 && b === ap.length - 1) || (a === ap.length - 1 && b === 0)) return;
		for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1);
	}));
	set(N - 8, 8, 1);
	for (let i = 0; i < 9; i++) { if (!R[8][i]) { M[8][i] = 0; R[8][i] = true; } if (!R[i][8]) { M[i][8] = 0; R[i][8] = true; } }
	for (let i = 0; i < 8; i++) { if (!R[8][N - 1 - i]) { M[8][N - 1 - i] = 0; R[8][N - 1 - i] = true; } if (!R[N - 1 - i][8]) { M[N - 1 - i][8] = 0; R[N - 1 - i][8] = true; } }
	if (ver >= 7) {
		let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
		const vb = (ver << 12) | rem;
		for (let i = 0; i < 18; i++) { const v = (vb >>> i) & 1, a = N - 11 + (i % 3), b = Math.floor(i / 3); set(b, a, v); set(a, b, v); }
	}
	/* данные по зигзагу */
	const bitsOut = []; out.forEach(b => { for (let i = 7; i >= 0; i--) bitsOut.push((b >>> i) & 1); });
	const place = mask => {
		const G = M.map(r => r.slice()); let k = 0, up = true;
		for (let c = N - 1; c > 0; c -= 2) {
			if (c === 6) c--;
			for (let t = 0; t < N; t++) {
				const r = up ? N - 1 - t : t;
				for (let d = 0; d < 2; d++) {
					const cc = c - d; if (R[r][cc]) continue;
					let v = k < bitsOut.length ? bitsOut[k++] : 0;
					const m = [ (r + cc) % 2 === 0, r % 2 === 0, cc % 3 === 0, (r + cc) % 3 === 0, (Math.floor(r / 2) + Math.floor(cc / 3)) % 2 === 0, (r * cc) % 2 + (r * cc) % 3 === 0, ((r * cc) % 2 + (r * cc) % 3) % 2 === 0, ((r + cc) % 2 + (r * cc) % 3) % 2 === 0 ][mask];
					G[r][cc] = v ^ (m ? 1 : 0);
				}
			}
			up = !up;
		}
		/* формат: уровень M = 00 */
		let rem = mask;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const fb = ((mask << 10) | rem) ^ 0x5412;
		for (let i = 0; i < 15; i++) {
			const v = (fb >>> i) & 1;
			if (i < 6) G[i][8] = v; else if (i === 6) G[7][8] = v; else if (i === 7) G[8][8] = v; else if (i === 8) G[8][7] = v; else G[8][14 - i] = v;
			if (i < 8) G[8][N - 1 - i] = v; else G[N - 15 + i][8] = v;
		}
		return G;
	};
	const pen = G => {
		let s = 0;
		for (let a = 0; a < 2; a++) for (let i = 0; i < N; i++) {
			let run = 1;
			for (let j = 1; j < N; j++) {
				const x = a ? G[j][i] : G[i][j], y = a ? G[j - 1][i] : G[i][j - 1];
				if (x === y) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1;
			}
		}
		for (let i = 0; i < N - 1; i++) for (let j = 0; j < N - 1; j++) if (G[i][j] === G[i][j + 1] && G[i][j] === G[i + 1][j] && G[i][j] === G[i + 1][j + 1]) s += 3;
		const pat = [ 1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0 ], pat2 = pat.slice().reverse();
		for (let a = 0; a < 2; a++) for (let i = 0; i < N; i++) for (let j = 0; j <= N - 11; j++) {
			let m1 = true, m2 = true;
			for (let k = 0; k < 11; k++) { const x = a ? G[j + k][i] : G[i][j + k]; if (x !== pat[k]) m1 = false; if (x !== pat2[k]) m2 = false; }
			if (m1) s += 40; if (m2) s += 40;
		}
		let dark = 0; G.forEach(r => r.forEach(v => { dark += v; }));
		return s + Math.floor(Math.abs(dark * 100 / (N * N) - 50) / 5) * 10;
	};
	let best = null, bp = 1e9;
	for (let m = 0; m < 8; m++) { const G = place(m), p = pen(G); if (p < bp) { bp = p; best = G; } }
	return best;
}

return baseclass.extend({ encode: nfQr });
