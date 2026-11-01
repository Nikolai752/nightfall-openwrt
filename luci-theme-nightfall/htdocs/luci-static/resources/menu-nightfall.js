'use strict';
'require baseclass';
'require ui';

return baseclass.extend({
	__init__() {
		ui.menu.load().then((tree) => this.render(tree));
	},

	render(tree) {
		let node = tree;
		let url = '';

		this.renderModeMenu(tree);
		this.renderCrumb(tree);
		this.bindSearch();

		if (L.env.dispatchpath.length >= 3) {
			for (var i = 0; i < 3 && node; i++) {
				node = node.children[L.env.dispatchpath[i]];
				url = url + (url ? '/' : '') + L.env.dispatchpath[i];
			}

			if (node)
				this.renderTabMenu(node, url);
		}
	},

	renderTabMenu(tree, url, level) {
		const container = document.querySelector('#tabmenu');
		const ul = E('ul', { 'class': 'tabs' });
		const children = ui.menu.getChildren(tree);
		let activeNode = null;

		children.forEach(child => {
			const isActive = (L.env.dispatchpath[3 + (level || 0)] == child.name);
			const activeClass = isActive ? ' active' : '';
			const className = 'tabmenu-item-%s %s'.format(child.name, activeClass);

			ul.appendChild(E('li', { 'class': className }, [
				E('a', { 'href': L.url(url, child.name) }, [ _(child.title) ] )]));

			if (isActive)
				activeNode = child;
		});

		if (ul.children.length == 0)
			return E([]);

		container.appendChild(ul);
		container.style.display = '';

		if (activeNode)
			this.renderTabMenu(activeNode, url + '/' + activeNode.name, (level || 0) + 1);

		return ul;
	},

	renderMainMenu(tree, url, level) {
		const ul = level ? E('ul', { 'class': 'dropdown-menu' }) : document.querySelector('#topmenu');
		const children = ui.menu.getChildren(tree);
		const dp = L.env.dispatchpath || [];

		if (children.length == 0 || level > 1)
			return E([]);

		children.forEach(child => {
			const submenu = this.renderMainMenu(child, url + '/' + child.name, (level || 0) + 1);
			const hasSub = !!submenu.firstElementChild;
			const isActive = level ? (dp[2] === child.name && url.split('/')[1] === dp[1]) : (dp[1] === child.name);
			const classes = [];

			if (!level && hasSub) classes.push('dropdown');
			if (isActive) classes.push('active');
			if (!level && hasSub && isActive) classes.push('open');

			const link = E('a', {
				'class': (!level && hasSub) ? 'menu' : '',
				'href': hasSub ? '#' : L.url(url, child.name)
			}, [ _(child.title) ]);
			if (!level) link.setAttribute('title', _(child.title));

			if (!level && hasSub)
				link.addEventListener('click', ev => {
					ev.preventDefault();
					link.parentNode.classList.toggle('open');
				});

			const attrs = { 'class': classes.join(' ') };
			if (!level) attrs['data-name'] = child.name;

			const li = E('li', attrs, [ link, submenu ]);

			ul.appendChild(li);
		});

		ul.style.display = '';

		return ul;
	},

	bindSearch() {
		const input = document.querySelector('#nf-find');
		const menu = document.querySelector('#topmenu');

		if (!input || !menu)
			return;

		const none = E('li', { 'class': 'nf-nores', 'hidden': '' }, [ 'Ничего не найдено' ]);
		menu.appendChild(none);

		const run = () => {
			const q = input.value.trim().toLowerCase();
			let any = false;

			menu.querySelectorAll(':scope > li:not(.nf-nores)').forEach(li => {
				const subs = li.querySelectorAll(':scope > ul > li');
				const head = li.querySelector(':scope > a').textContent.toLowerCase();

				if (li.dataset.open == null)
					li.dataset.open = li.classList.contains('open') ? '1' : '0';

				if (!q) {
					li.hidden = false;
					subs.forEach(s => { s.hidden = false; });
					li.classList.toggle('open', li.dataset.open === '1');
					any = true;
					return;
				}

				const headHit = head.includes(q);
				let subHit = false;

				subs.forEach(s => {
					const m = s.textContent.toLowerCase().includes(q);
					s.hidden = !(m || headHit);
					subHit = subHit || m;
				});

				li.hidden = !(headHit || subHit);

				if (subs.length)
					li.classList.toggle('open', headHit || subHit);

				any = any || !li.hidden;
			});

			none.hidden = !q || any;
		};

		input.addEventListener('input', run);
		input.addEventListener('keydown', ev => {
			if (ev.key === 'Escape') {
				input.value = '';
				run();
				input.blur();
			}
			else if (ev.key === 'Enter') {
				const hit = Array.from(menu.querySelectorAll('a[href]:not([href="#"])')).find(a => !a.closest('[hidden]'));
				if (hit) location.href = hit.getAttribute('href');
			}
		});

		document.addEventListener('keydown', ev => {
			if (ev.key === '/' && !ev.ctrlKey && !ev.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
				ev.preventDefault();
				input.focus();
			}
		});
	},

	renderCrumb(tree) {
		const box = document.querySelector('#nf-crumb');
		const dp = L.env.dispatchpath || [];
		let node = tree;

		if (!box)
			return;

		for (let i = 0; i < 3 && node; i++) {
			node = node.children ? node.children[dp[i]] : null;

			if (node && i > 0 && node.title)
				box.appendChild(E('span', {}, [ _(node.title) ]));
		}
	},

	renderModeMenu(tree) {
		const ul = document.querySelector('#modemenu');
		const children = ui.menu.getChildren(tree);

		children.forEach((child, index) => {
			const isActive = L.env.requestpath.length
				? child.name === L.env.requestpath[0]
				: index === 0;

			ul.appendChild(E('li', { 'class': isActive ? 'active' : '' }, [
				E('a', { 'href': L.url(child.name) }, [ _(child.title) ])
			]));

			if (isActive)
				this.renderMainMenu(child, child.name);
		});

		if (ul.children.length > 1)
			ul.style.display = '';
	}
});
