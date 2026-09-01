# Backend – XFace43 Device Management

Bu klasör Express API'sini ve cihazın TCP/5006 bağlantısını içerir. `web/` React yönetim paneli, `mobile/` ise Flutter istemcisidir.

## Başlatma

Bu klasörde PowerShell açın ve şunları çalıştırın:

```powershell
npm.cmd install
npm.cmd run dev
```

Çıktıda hem API (`http://localhost:3001`) hem WEB (`http://localhost:5173`) satırları görünmelidir.

Sadece backend: `npm.cmd run dev:backend`

Sadece web: `npm.cmd run dev:web`

## Mobil

```powershell
cd ..\mobile
C:\flutter\bin\flutter.bat run
```

Telefon uygulamasında Node API adresi olarak backend'i çalıştıran bilgisayarın LAN adresini girin; örnek: `http://192.168.1.227:3001`. Bu adres cihazın IP'si değildir.

## Doğrulanmış işlevler

- TCP bağlantı/ping
- cihaz saati, sürümü, sayaçlar ve cihaz bilgileri
- kullanıcı listesi ve kullanıcı adı okuma
- PIN kullanıcı ekleme ve yalnız PIN enrollment silme
- devam kayıtlarını okuma
- kapı kontrolü
- cihazı etkinleştirme/devre dışı bırakma

Doğrulanmayan yüz/parmak izi silme, saat yazma, ağ ayarları ve UDP işlemleri etkin özellik olarak sunulmaz.

Tüm TCP protokolü ve cihaz yapılandırma notları
[`docs/FKAttend_TCP_Protocol.md`](./docs/FKAttend_TCP_Protocol.md) dosyasındadır.
