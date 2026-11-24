/* Центрирование пустых состояний таблиц LuCI на всех размерах экрана.
 * LuCI и мобильная раскладка могут сжать единственную ячейку пустой строки
 * до ширины первой колонки. Растягиваем такую строку на таблицу и центрируем
 * содержимое. Обработчик общий: DHCPv4/v6, dnsmasq, odhcpd и другие вкладки
 * с тем же шаблоном LuCI получают одинаковое оформление.
 */
(function () {
	'use strict';
	try {
		var raf = 0;
		var set = function (node, styles) {
			for (var key in styles)
				node.style.setProperty(key, styles[key], 'important');
		};
		var FULL = {
			width: '100%',
			'max-width': '100%',
			'min-width': '0',
			margin: '0',
			float: 'none',
			'box-sizing': 'border-box',
			transform: 'none'
		};

		function fixEmpty(em) {
			var row = em.closest('.tr, tr');
			if (!row || row.children.length !== 1) return;

			var table = row.parentElement && row.parentElement.closest('.table, table, .cbi-section-table');
			if (!table) return;

			var tableWidth = table.getBoundingClientRect().width;
			if (!tableWidth) return; /* вкладка пока скрыта; повторим после её открытия */

			var cell = row.firstElementChild;
			/* На desktop и mobile пустая строка должна занимать всю ширину
			 * таблицы/карточки. В мобильной раскладке LuCI строки могут быть
			 * grid/flex-элементами фиксированной ширины, поэтому одного
			 * text-align недостаточно: растягиваем именно пустую строку.
			 */
			for (var node = em.parentElement; node && node !== table; node = node.parentElement) {
				set(node, FULL);
				if (node === row) {
					set(node, {
						display: 'flex',
						'flex': '0 0 100%',
						'flex-wrap': 'wrap',
						'align-items': 'center',
						'justify-content': 'center',
						'align-self': 'stretch',
						'grid-column': '1 / -1',
						'box-sizing': 'border-box'
					});
				}
				else if (node === cell) {
					set(node, {
						display: 'flex',
						'flex': '1 1 100%',
						'flex-direction': 'column',
						'align-items': 'center',
						'justify-content': 'center',
						'align-self': 'stretch',
						'grid-column': '1 / -1',
						'width': '100%',
					'min-width': '0',
					'height': 'auto',
					'position': 'static',
					'text-align': 'center',
					'box-sizing': 'border-box',
					'padding': '26px 16px'
					});
				}
			}
			set(em, {
				display: 'block',
				width: '100%',
				'max-width': '100%',
				margin: '0 auto',
				'text-align': 'center',
				'white-space': 'normal'
			});
		}

		function fix() {
			raf = 0;
			document.querySelectorAll('.table em, .cbi-section-table em, table em').forEach(fixEmpty);
		}

		function schedule() {
			if (!raf) raf = requestAnimationFrame(fix);
		}

		function start() {
			fix();
			new MutationObserver(schedule).observe(document.body, {
				childList: true,
				subtree: true
			});
			window.addEventListener('resize', schedule);
			window.addEventListener('load', schedule);
			window.addEventListener('pageshow', schedule);
			/* Пересчитать ширину после переключения вкладки, включая ранее скрытые таблицы. */
			document.addEventListener('click', function (ev) {
				if (ev.target.closest('.cbi-tab, .cbi-tabmenu, [role="tab"], .tabs')) schedule();
			}, true);
		}

		if (document.body) start();
		else document.addEventListener('DOMContentLoaded', start);
	}
	catch (e) { /* Не мешаем работе остальных страниц LuCI. */ }
})();
