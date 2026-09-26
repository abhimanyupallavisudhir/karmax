(async () => {
  const status = document.getElementById('checkout-status');
  const retry = document.getElementById('checkout-retry');
  const params = new URLSearchParams(location.search);
  const transactionId = params.get('_ptxn');
  let successUrl;
  try {
    const candidate = new URL(params.get('success') || '', location.origin);
    if (params.has('success') && candidate.origin === location.origin
      && !candidate.username && !candidate.password && candidate.pathname !== '/billing/checkout') successUrl = candidate.href;
  } catch { /* Invalid return links leave the payment confirmation visible. */ }
  if (!/^txn_[a-z0-9]{26}$/.test(transactionId || '')) {
    status.textContent = 'Start checkout from your organization’s Plan & billing settings.';
    return;
  }
  try {
    const response = await fetch('/api/subscriptions/paddle/checkout-config', { cache: 'no-store' });
    if (!response.ok) throw new Error('Checkout is temporarily unavailable.');
    const config = await response.json();
    if (!window.Paddle) throw new Error('Paddle could not load. Check your connection and reload this page.');
    if (config.environment === 'sandbox') Paddle.Environment.set('sandbox');
    let completed = false;
    Paddle.Initialize({ token: config.clientToken, eventCallback(event) {
      if (event.name === 'checkout.completed') {
        completed = true;
        status.textContent = 'Payment received. Your plan will update after Paddle confirms it.';
        retry.hidden = true;
        if (successUrl) location.assign(successUrl);
      } else if (event.name === 'checkout.closed' && !completed) {
        status.textContent = 'Checkout closed.';
        retry.hidden = false;
      } else if (event.name === 'checkout.error' && !completed) {
        status.textContent = 'Checkout could not complete. Please try again.';
        retry.hidden = false;
      }
    } });
    const open = () => Paddle.Checkout.open({ transactionId, settings: { displayMode: 'overlay' } });
    retry.addEventListener('click', open);
    status.textContent = config.environment === 'sandbox' ? 'Test checkout — no real payment.' : 'Payments are securely handled by Paddle.';
    // Paddle.js opens _ptxn links automatically after Initialize.
  } catch (error) {
    status.textContent = error.message || 'Checkout is temporarily unavailable.';
  }
})();
