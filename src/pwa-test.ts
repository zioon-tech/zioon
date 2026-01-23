/**
 * PWA 测试工具
 * 用于检查 Service Worker 和 PWA 功能
 */

export function checkPWAStatus() {
  console.log('🔍 PWA Status Check');
  console.log('===================');

  // 检查 Service Worker 支持
  if ('serviceWorker' in navigator) {
    console.log('✅ Service Worker is supported');

    // 检查已注册的 Service Worker
    navigator.serviceWorker.getRegistrations().then(registrations => {
      console.log(`📋 Found ${registrations.length} registered Service Worker(s)`);
      registrations.forEach((registration, index) => {
        console.log(`\n[${index + 1}] ${registration.scope}`);
        console.log(`   - Active: ${!!registration.active}`);
        console.log(`   - Waiting: ${!!registration.waiting}`);
        console.log(`   - Installing: ${!!registration.installing}`);
      });

      // 检查是否有新的 Service Worker
      if (registrations.length > 0) {
        const registration = registrations[0];
        if (registration.waiting) {
          console.log('⏳ New Service Worker is waiting, you may need to reload');
        }

        // 监听更新
        registration.addEventListener('updatefound', () => {
          console.log('🔄 Service Worker update found!');
        });
      }
    });
  } else {
    console.log('❌ Service Worker is NOT supported');
  }

  // 检查 Manifest 支持
  const manifestLink = document.querySelector('link[rel="manifest"]');
  if (manifestLink) {
    console.log('✅ Web App Manifest link found');
    console.log(`   - URL: ${manifestLink.getAttribute('href')}`);
  } else {
    console.log('⚠️  Web App Manifest link NOT found');
  }

  // 检查在线状态
  console.log(`\n📡 Network status: ${navigator.onLine ? 'Online' : 'Offline'}`);

  window.addEventListener('online', () => console.log('🟢 Back online'));
  window.addEventListener('offline', () => console.log('🔴 Gone offline'));

  // 检查是否可以作为应用安装
  if ('beforeinstallprompt' in window) {
    console.log('✅ Install prompt is supported');

    window.addEventListener('beforeinstallprompt', (e) => {
      console.log('💡 Install prompt fired - user can install the app!');

      // 保存事件以供稍后使用
      let deferredPrompt: any;
      deferredPrompt = e;

      // 可以在这里显示安装按钮
      const installBtn = document.createElement('button');
      installBtn.textContent = 'Install App';
      installBtn.style.position = 'fixed';
      installBtn.style.top = '10px';
      installBtn.style.right = '10px';
      installBtn.style.zIndex = '10000';
      installBtn.style.padding = '10px 20px';
      installBtn.style.backgroundColor = '#2563eb';
      installBtn.style.color = 'white';
      installBtn.style.border = 'none';
      installBtn.style.borderRadius = '5px';
      installBtn.style.cursor = 'pointer';

      installBtn.addEventListener('click', async () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          const { outcome } = await deferredPrompt.userChoice;
          console.log(`User response: ${outcome}`);
          deferredPrompt = null;
          installBtn.remove();
        }
      });

      document.body.appendChild(installBtn);
    });
  } else {
    console.log('⚠️  Install prompt is NOT supported (may work on mobile)');
  }

  console.log('\n===================');
}

// 在页面加载后自动检查
if (typeof window !== 'undefined') {
  window.addEventListener('load', checkPWAStatus);
}
