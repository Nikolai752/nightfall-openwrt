'use strict';
'require baseclass';
'require fs';

/* Nightfall: thin status line at the top edge: green = internet works, red = no connection.
 * Source: nightfall-collector (ping history). No data (collector stopped) = line is hidden. */
return baseclass.extend({
	__init__() {
		if (!document.body || document.getElementById('nf-netbar')) return;

		const bar = E('div', { 'id': 'nf-netbar', 'title': 'Интернет: нет данных' });
		document.body.appendChild(bar);

		const tick = () => {
			if (document.hidden) return;
			fs.exec('/usr/libexec/nightfall-history', [ 'alerts' ]).then(res => {
				let h = null;
				try { h = JSON.parse(res.stdout); } catch (e) { /* ignore */ }
				const last = h && h.info && h.info.started ? (h.last || [])[0] : null;
				const fresh = last && h.now - last[0] <= 90;
				if (!fresh) { bar.removeAttribute('data-s'); bar.title = 'Интернет: нет данных (сборщик не запущен)'; return; }
				const wanDown = (h.active || []).some(a => a[0] === 'wan');
				const ok = last[7] >= 0 && !wanDown;
				bar.setAttribute('data-s', ok ? 'ok' : 'bad');
				bar.title = ok ? 'Интернет работает, задержка ' + Math.round(last[7]) + ' мс' : 'Нет связи с интернетом';
			}).catch(() => bar.removeAttribute('data-s'));
		};

		tick();
		window.setInterval(tick, 10000);
	}
});
