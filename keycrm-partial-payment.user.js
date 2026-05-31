// ==UserScript==
// @name         KeyCRM — частичная оплата
// @namespace    company.internal
// @version      1.0.0
// @description  Частичная оплата для KeyCRM
// @match        *://*.keycrm.app/*
// @match        *://keycrm.app/*
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  GM_addStyle(`
    .kcrm-partial-payment-row {
      display: flex;
      gap: 8px;
      align-items: stretch;
      width: 100%;
    }

    .kcrm-partial-payment-row .kcrm-fraction-wrap {
      flex: 0 0 42%;
      min-width: 0;
    }

    .kcrm-partial-payment-row .kcrm-amount-wrap {
      flex: 1 1 58%;
      min-width: 0;
    }

    .kcrm-partial-payment-label {
      display: block;
      font-size: 12px;
      line-height: 1.4;
      margin-bottom: 4px;
      color: var(--text-color, #606266);
    }

    .kcrm-partial-payment-item {
      margin-bottom: 12px;
    }

    .kcrm-partial-payment-item .el-form-item__content {
      margin-left: 0 !important;
    }
  `);

  const FRACTIONS = [
    { label: '1/2', value: 1 / 2 },
    { label: '1/3', value: 1 / 3 },
    { label: '1/4', value: 1 / 4 },
    { label: '1/5', value: 1 / 5 },
    { label: '1/10', value: 1 / 10 },
  ];

  const INJECTED_ATTR = 'data-kcrm-partial-payment';
  let activeOrderRoot = null;

  function findOrderRootFromTarget(target) {
    if (!target || !(target instanceof Element)) return null;

    return (
      target.closest('.view-order') ||
      target.closest('.key-datatable-detail-row')?.querySelector('.view-order') ||
      null
    );
  }

  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest('button, .el-popover__reference');

      if (!btn?.textContent?.includes('Добавить оплату')) return;
      if (!btn.closest('.payments-part, .order-prices, .view-order')) return;

      const root = findOrderRootFromTarget(btn);

      if (root) activeOrderRoot = root;
    },
    true
  );

  function parsePriceText(text) {
    if (!text) return 0;

    const cleaned = text
      .replace(/\u00a0/g, ' ')
      .replace(/грн\.?/gi, '')
      .replace(/\s/g, '')
      .replace(',', '.')
      .replace(/[^\d.-]/g, '');

    const n = parseFloat(cleaned);

    return Number.isFinite(n) ? n : 0;
  }

  function getOrderTotal(orderRoot) {
    if (!orderRoot) return 0;

    const sumPart = orderRoot.querySelector('.sum-part');

    if (sumPart) {
      for (const item of sumPart.querySelectorAll('.price-item')) {
        const label = item.querySelector('.price-label');

        if (label?.textContent?.includes('Сумма за товары')) {
          const val = item.querySelector('.price-value.md');

          if (val) return parsePriceText(val.textContent);
        }
      }

      const first = sumPart.querySelector('.price-value.md');

      if (first) return parsePriceText(first.textContent);
    }

    const fallback = orderRoot.querySelector('.price-value.md');

    return fallback ? parsePriceText(fallback.textContent) : 0;
  }

  function formatUah(amount) {
    const fixed = Math.round(amount * 100) / 100;
    const [intPart, dec] = fixed.toFixed(2).split('.');
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

    return `${grouped},${dec} грн.`;
  }

  function createFormItem(labelText, contentEl) {
    const item = document.createElement('div');

    item.className =
      'el-form-item el-form-item--small kcrm-partial-payment-item';

    const content = document.createElement('div');

    content.className = 'el-form-item__content';
    content.style.marginLeft = '0px';

    if (labelText) {
      const label = document.createElement('label');

      label.className = 'kcrm-partial-payment-label';
      label.textContent = labelText;

      content.appendChild(label);
    }

    content.appendChild(contentEl);
    item.appendChild(content);

    return item;
  }

  function buildFractionSelect(onChange) {
    const outer = document.createElement('div');

    outer.className = 'el-select full-width el-select--small';

    const inputWrap = document.createElement('div');

    inputWrap.className = 'el-input el-input--small el-input--suffix';

    const select = document.createElement('select');

    select.className = 'el-input__inner';

    FRACTIONS.forEach((f, i) => {
      const opt = document.createElement('option');

      opt.value = String(f.value);
      opt.textContent = f.label;

      if (i === 0) opt.selected = true;

      select.appendChild(opt);
    });

    select.addEventListener('change', () => {
      onChange(parseFloat(select.value));
    });

    inputWrap.appendChild(select);
    outer.appendChild(inputWrap);

    return { outer, select };
  }

  function buildReadonlyAmount() {
    const wrap = document.createElement('div');

    wrap.className =
      'full-width el-input el-input--small is-disabled el-input-group el-input-group--append';

    const input = document.createElement('input');

    input.type = 'text';
    input.readOnly = true;
    input.tabIndex = -1;
    input.className = 'el-input__inner';

    const append = document.createElement('div');

    append.className = 'el-input-group__append';
    append.textContent = 'UAH';

    wrap.appendChild(input);
    wrap.appendChild(append);

    return { wrap, input };
  }

  function findNearestOrderRoot(popover) {
    const details = [...document.querySelectorAll('.view-order')].filter(
      (el) => {
        const row = el.closest('.key-datatable-detail-row');

        if (!row) return false;

        const rect = row.getBoundingClientRect();

        return rect.height > 0 && rect.width > 0;
      }
    );

    if (details.length === 1) return details[0];

    const popRect = popover.getBoundingClientRect();

    let best = null;
    let bestDist = Infinity;

    for (const el of details) {
      const r = el.getBoundingClientRect();

      const dist =
        Math.abs(r.top - popRect.bottom) +
        Math.abs(r.left - popRect.left);

      if (dist < bestDist) {
        bestDist = dist;
        best = el;
      }
    }

    return best;
  }

  function injectIntoPopover(popover) {
    if (popover.getAttribute(INJECTED_ATTR) === '1') return;

    const form = popover.querySelector('form.el-form');

    if (!form) return;

    const orderRoot = activeOrderRoot || findNearestOrderRoot(popover);

    let total = getOrderTotal(orderRoot);

    const row = document.createElement('div');

    row.className = 'kcrm-partial-payment-row';

    const { outer: fractionOuter, select } = buildFractionSelect(
      (fraction) => {
        readonlyInput.value = formatUah(total * fraction);
      }
    );

    const { wrap: amountWrap, input: readonlyInput } =
      buildReadonlyAmount();

    row.appendChild(fractionOuter);
    row.appendChild(amountWrap);

    const block = createFormItem('Часткова оплата', row);

    const amountField = form
      .querySelector('input[name="amount"]')
      ?.closest('.el-form-item');

    if (amountField) {
      form.insertBefore(block, amountField);
    } else {
      form.appendChild(block);
    }

    readonlyInput.value = formatUah(total * parseFloat(select.value));

    popover.setAttribute(INJECTED_ATTR, '1');
  }

  function scanPopovers() {
    document.querySelectorAll('.payments-popper').forEach((popover) => {
      const hidden = popover.getAttribute('aria-hidden') === 'true';

      if (!hidden) injectIntoPopover(popover);
    });
  }

  const bodyObserver = new MutationObserver(scanPopovers);

  bodyObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
  });

  scanPopovers();
})();