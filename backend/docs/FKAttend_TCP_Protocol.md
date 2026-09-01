# FKAttend / XFace43 TCP Protokolü

Bu belge, `FKAttend.dll` kullanmadan XFace43 cihazıyla ham TCP üzerinden
haberleşmek için Wireshark kayıtlarından ve bu projedeki uygulamadan çıkarılan
tek kaynak dokümantasyondur. Eski çalışma notları bu dosyada birleştirilmiştir.

## Kapsam ve bağlantı

| Alan | Değer |
|---|---|
| Test edilen cihaz | XFace43-FTW, `V5.8` ürün metni gözlendi |
| Varsayılan IP | `192.168.1.215` — cihaz ağ ayarıdır, sabit kabul edilmemelidir |
| TCP portu | `5006` |
| Taşıma | Ham ikili TCP |
| İstemci | Sadece backend/local agent; web ve mobil ham TCP açmaz |
| Sayı düzeni | Çok baytlı sayılar little-endian (`u16`/`u32`) |
| Dialect | SDK kayıtlarında çoğunlukla `02`; eski ping testinde `01` de çalıştı |

> Cihazdaki **Server Request** seçeneği açıkken doğrudan TCP yönetim
> bağlantısı cevap vermemiş, kapatıldığında çalışmıştır. Cihaz IP'si, ağ geçidi,
> subnet, TCP 5006 ve bu seçenek cihaz menüsünden doğrulanmalıdır.

```text
Web / Mobil -> REST API -> Backend -> FkAttendTcpClient -> TCP/5006 -> Cihaz
```

## Çerçeve biçimi

### Kısa istek — 16 bayt

| Ofset | Boyut | Açıklama |
|---:|---:|---|
| 0 | 2 | Başlık: `55 AA` |
| 2 | 1 | Dialect (`02` tercih edilir) |
| 3 | 1 | Komut |
| 4 | 10 | Komuta özel argümanlar |
| 14 | 2 | İstek sıra numarası, `u16 LE` |

Örnek B4 durum sorgusu:

```text
55 AA 02 B4 08 00 00 00 00 00 FF FF 00 00 0D 00
```

### Kısa yanıt — genellikle 10 bayt

| Ofset | Boyut | Açıklama |
|---:|---:|---|
| 0 | 2 | Başlık: `AA 55` |
| 2 | 1 | Cihaz dialect'i |
| 3 | 1 | Komuta bağlı yanıt türü |
| 4 | 4 | Sonuç/değer, komuta göre yorumlanır |
| 8 | 2 | Yanıt sıra numarası |

`response[3]` global başarı bayrağı değildir. Örneğin `GetDeviceVersion (79)`
geçerli cevapta `00` döndürür. Yanıt hem komut hem de beklenen uzunluğa göre
ayrıştırılmalıdır.

### Uzun veri paketi

Uzun veri yazma istekleri 16 baytlık başlığın ardından şu biçimi kullanır:

```text
[16-byte request]
55 AA
[content]
00 00
```

Başlık ofset `12..13`, yalnız içerik uzunluğunu taşır. Uzun yanıtlarda genel
olarak kısa yanıtı `55 AA`, veri ve 4 baytlık trailer izler.

## Komut özeti

| Hex | Komut | Durum |
|---:|---|---|
| `79` | GetDeviceVersion | gözlendi |
| `80` | Ping | doğrulandı |
| `81` | Cihazı etkinleştir/devre dışı bırak | doğrulandı |
| `92` | SaveEnrollData | doğrulandı |
| `93` | DeleteEnrollData (PIN/yüz/parmak izi) | doğrulandı |
| `97` | GetAllUserID / kullanıcı dizini | doğrulandı |
| `98` | PutEnrollData | doğrulandı; sıfır olmayan PIN bayt konumu ek capture ile kesinleştirilmeli |
| `A4` | Devam kaydı blok transferi | doğrulandı |
| `B0` | GetDeviceInfo | doğrulandı |
| `B2` | GetDeviceTime | doğrulandı |
| `B4` | GetDeviceStatus | doğrulandı |
| `C3` | Ürün metni | gözlendi |
| `C7` / `C8` | Kullanıcı adı oku/yaz | doğrulandı |
| `E1` | Kapı durumu | doğrulandı |
| `F2` / `F3` | JPEG kullanıcı fotoğrafı başlat/blok aktar | doğrulandı |

## Bağlantı ve istek yönetimi

```text
connect(host, 5006)
-> setNoDelay(true)
-> sıra numarası üret
-> tek isteği gönder
-> AA 55 başlığını ve sıra numarasını doğrula
-> komuta ait beklenen veri uzunluğunu oku
-> timeout, error ve close durumlarını işle
```

Cihazla aynı TCP bağlantısında **aynı anda yalnız bir aktif istek**
bulunmalıdır. Her işlemden sonra hata halinde socket kapatılmalıdır.

## Cihaz kontrolü

### Ping (`80`)

```text
55 AA 02 80 00 00 00 00 00 00 00 00 00 00 SEQ_LO SEQ_HI
```

Başarılı yanıtta `AA 55 02 01 ...` gözlenmiştir.

### Enable / Disable (`81`)

```text
# Disable
55 AA 02 81 00 00 00 00 00 00 FF FF 00 00 SEQ

# Enable
55 AA 02 81 01 00 00 00 00 00 FF FF 00 00 SEQ
```

Kayıt veya fotoğraf yazmadan önce disable, işlem tamamlanınca enable gönderilir.

### Kapı kontrolü (`E1`)

```text
55 AA 02 E1 [STATUS u32 LE] 00 00 FF FF 00 00 SEQ
```

| Durum | Anlam |
|---:|---|
| 0 | Cihaz kontrolü/reset |
| 1 | Kapıyı aç |
| 2 | Kapıyı kapat |
| 3 | Aç, ardından otomatik kapat |

## Cihaz bilgileri ve yapılandırma okunması

### Cihaz saati (`B2`)

```text
55 AA 02 B2 00 00 00 00 00 00 00 00 08 00 SEQ
```

Uzun yanıttaki 8 baytlık saat alanı:

| Ofset | Boyut | Alan |
|---:|---:|---|
| 0 | 2 | Yıl, `u16 LE` |
| 2 | 1 | Ay |
| 3 | 1 | Gün |
| 4 | 1 | Haftanın günü |
| 5 | 1 | Saat |
| 6 | 1 | Dakika |
| 7 | 1 | Saniye |

Örnek: `EA 07 08 1C 06 0E 3B 33` = 2026-08-28 14:59:51.

### Cihaz saatini yazma (`B3`) — doğrulandı

`cihaz-saati-degistirme.pcapng` kaydı, SDK'nın saat değiştirirken şu akışı
kullandığını doğrular:

```text
81 Disable -> B3 SetDeviceTime -> 81 Enable
```

Örnek capture, 2026-09-01 10:42:00 için (sıra numaraları örnektir):

```text
# Disable, sequence 0x003B
55 AA 02 81 00 00 00 00 00 00 FF FF 00 00 3B 00

# B3 SetDeviceTime, sequence 0x003C
55 AA 02 B3 00 00 00 00 00 00 00 00 08 00 3C 00
55 AA
EA 07 09 01 02 0A 2A 00
00 00

# Enable, sequence 0x003D
55 AA 02 81 01 00 00 00 00 00 FF FF 00 00 3D 00
```

`B3` genişletilmiş isteğinin içeriği 8 bayttır ve `B2 GetDeviceTime`
yanıtındaki tarih/saat düzeniyle aynıdır:

| İçerik ofseti | Boyut | Alan |
|---:|---:|---|
| 0 | 2 | Yıl, `u16 LE` |
| 2 | 1 | Ay |
| 3 | 1 | Gün |
| 4 | 1 | Haftanın günü (`Date.getDay()`: Pazar = 0) |
| 5 | 1 | Saat |
| 6 | 1 | Dakika |
| 7 | 1 | Saniye |

Kısa cihaz yanıtı: `AA 55 02 01 00 00 00 00 SEQ`. Backend, geçersiz takvim
tarihini reddeder ve hata olsa dahi cihazı yeniden etkinleştirmeyi dener.

### Cihaz bilgi değeri (`B0`)

```text
55 AA 02 B0 [INFO_INDEX u32 LE] [PREVIOUS/VALUE u16] FF FF 00 00 SEQ
```

Sonuç kısa yanıtın `4..7` ofsetinde `u32 LE`'dir.

| Index | Gözlenen SDK anlamı | Örnek değer |
|---:|---|---:|
| 1 | Maksimum manager | 99 |
| 2 | Makine numarası | 2 |
| 3 | Dil | 0 |
| 4 | Otomatik kapanma süresi | 0 |
| 5 | Kilit kontrol bayrağı | 1 |
| 6 | Genel kayıt uyarı eşiği | 1000 |
| 7 | Yönetici kayıt uyarı eşiği | 100 |
| 8 | Doğrulama aralığı | 0 |
| 9 | Seri baud ayarı | 0 |
| 10 | Tarih ayırıcı/gösterim | 0 |

`15`, `24`, `77` gibi firmware'e özel indeksler görüldü; anlamları farklı
indekslerle capture alınmadan uygulama ayarı olarak kullanılmamalıdır.

### Durum ve sayaç (`B4`)

```text
55 AA 02 B4 [STATUS_INDEX u32 LE] [VALUE/WORK u16] FF FF 00 00 SEQ
```

| Index | Anlam |
|---:|---|
| 1 | Manager sayısı |
| 2 | Normal kullanıcı sayısı |
| 3 | Parmak izi sayısı |
| 4 | PIN/şifre sayısı |
| 5 | Yeni yönetici log sayısı |
| 6 | Yeni devam/genel log sayısı |
| 7 | Toplam yönetici log sayısı |
| 8 | Toplam devam/genel log sayısı |
| 9 | Kart sayısı |

### Sürüm (`79`) ve ürün metni (`C3`)

```text
# GetDeviceVersion
55 AA 02 79 00 00 00 00 10 00 FF FF 00 00 SEQ

# ProductData gözlenen varyantı
55 AA 02 C3 00 01 00 00 00 00 00 00 00 01 SEQ
```

`C3` uzun yanıtında 256 bayt ASCII metin gözlenir; örnek: `xFace43-FTW V5.8`.
C3 içindeki ürün indeksi alanının kesin konumu yalnız bir varyantta görüldüğü
için farklı indeksler için henüz doğrulanmamıştır.

## Kullanıcı ve enrollment işlemleri

### Kullanıcı dizini (`97`)

Önce `B4` indeks 1 ve 2 ile toplam kullanıcı sayısı alınır:

```text
totalCount = managerCount + normalUserCount
payloadLength = totalCount * 10
```

```text
55 AA 02 97
[PAYLOAD_LENGTH u32 LE]
[TOTAL_COUNT u32 LE]
[PAYLOAD_LENGTH u16 LE]
SEQ
```

Yanıt, 10 baytlık dizin girdilerinden oluşur. Her girdinin ilk 4 baytı
kullanıcı ID'sidir (`u32 LE`). Kalan 6 baytın semantiği doğrulanmamıştır.
Adı almak için her ID'ye ayrı `C7` istek gönderilir.

### Kullanıcı adı oku (`C7`) ve yaz (`C8`)

```text
# C7 GetUserName
55 AA 02 C7 [USER_ID u32 LE] 00 00 00 00 80 00 SEQ

# C8 SetUserName başlığı
55 AA 02 C8 [USER_ID u32 LE] 00 00 00 00 80 00 SEQ
55 AA [128-byte UTF-16LE name, zero padded] 00 00
```

Örnek `deneme2`: `64 00 65 00 6E 00 65 00 6D 00 65 00 32 00`.

### PIN enrollment yazma (`98`) ve kalıcılaştırma (`92`)

`BACKUP_PSW = 10`.

```text
55 AA 02 98
0A 00 00 00                 # Backup = password
00 00 00 00                 # privilege
38 00                       # content length = 56
SEQ
55 AA
[56-byte content]
00 00
```

| İçerik ofseti | Boyut | Alan |
|---:|---:|---|
| 0 | 4 | Kullanıcı ID, `u32 LE` |
| 4 | 4 | Backup numarası = 10 |
| 8 | 4 | Yetki (`0` normal, `1` manager) |
| 12 | 40 | Enrollment buffer |
| 52 | 4 | PIN, `u32 LE` |

Örnek PIN `1234`: `D2 04 00 00`. Sıfır olmayan PIN için son bayt dizilimi
uygulamada kullanılır; yeni bir Wireshark kaydıyla byte-byte teyit edilmesi
tavsiye edilir.

Yazma ardından kalıcılık için:

```text
55 AA 02 92 01 00 00 00 00 00 FF FF 00 00 SEQ
```

### Enrollment silme (`93`)

```text
55 AA 02 93
[USER_ID u32 LE]
[BACKUP u16 LE]
FF FF 00 00
SEQ
```

| Backup | Kayıt türü |
|---:|---|
| 10 | PIN/şifre |
| 30 | Yüz kaydı |
| 0 | Parmak izi |

PIN-only kullanıcıda `93 + backup 10`, kullanıcıyı dizinden de kaldırdığı
capture ile doğrulanmıştır.

`parmak-izi-silme.pcapng` kaydında kullanıcı ID `3` için parmak izi silme:

```text
55 AA 02 93 03 00 00 00 00 00 FF FF 00 00 17 00
```

Bu pakette `backup = 0` parmak izi enrollment'ını belirtir; cihaz onayı:
`AA 55 02 01 00 00 00 00 17 00`.

`pin-silme.pcapng` kaydında kullanıcı ID `3` için gözlenen tam istek:

```text
55 AA 02 93 03 00 00 00 0A 00 FF FF 00 00 39 00
```

Buradaki `39 00` sıra numarasıdır. Capture'da aynı TCP yükünün kısa süre sonra
tekrar görülmesi uygulama seviyesinde ikinci silme değildir; TCP retransmission
olarak işaretlenmiştir. Cihaz ikinci iletimden sonra şu onayı döndürür:

```text
AA 55 02 01 00 00 00 00 39 00
```

### JPEG kullanıcı fotoğrafı (`F2`, `F3`)

Akış: `81 Disable` → `F2` başlat → sıralı `F3` blokları → `81 Enable`.

F2 meta verisi 20 bayttır:

```text
u32 1             # fotoğraf türü
u32 userId
u32 0
u32 jpegByteSize
u32 0
```

F3 JPEG verisini 1024 baytlık bloklara böler. Kısa başlığın argüman ofset
`6..7` alanı blok indeksi, `8..9` alanı o bloktaki bayt sayısıdır (`u16 LE`).
Her blok için cihaz onayı beklenmelidir; yalnız JPEG kabul edilmelidir.

## Devam kayıtları (`A4`)

Önce toplam kayıt sayısını `B4`, indeks `8` ile alın:

```text
totalBytes = count * 20
```

İlk blok:

```text
55 AA 02 A4
00 00 00 00
[TOTAL_RECORD_COUNT u16 LE]
00 00                       # block index = 0
00 04                       # length = 1024
SEQ
```

Sonraki bloklar için block index artırılır, son blokta kalan bayt sayısı
gönderilir. Yanıt uzun verisindeki ilk 4 bayt blok başlığıdır; kayıt verisine
dahil edilmez.

Bu cihazda her kayıt **20 bayttır**. Eski R701 varyantlarındaki 12 baytlık
kayıt biçimi XFace43 için kullanılmamalıdır.

| Ofset | Boyut | Alan | Güven |
|---:|---:|---|---|
| 0 | 4 | Kullanıcı ID, `u32 LE` | yüksek |
| 4 | 8 | Cihaz tarih/saat alanı | ham biçim gözlendi; bit çözümü teyitsiz |
| 12 | 4 | In/out veya ek durum | yüksek |
| 16 | 4 | Doğrulama yöntemi | yüksek |

Gözlenen doğrulama eşlemesi: `1 = parmak izi`, `2 = PIN`, `20 = yüz`.

## Henüz uygulanmaması gereken ayarlar

Aşağıdaki komutlar için yeterli capture/doğrulama yoktur. Cihaz konfigürasyon
ayarını bozma riski nedeniyle backend API'si bunları etkin özellik olarak
sunmamalıdır:

- GetEnrollData / SetEnrollData (yüz)
- GetEnrollPhoto / SetEnrollPhoto / DeleteEnrollPhoto
- EnableUser / DisableUser
- ModifyPrivilege (`95` ve `96` gözlendi, semantik teyitsiz)
- GetDoorStatus
- Bell GET/SET
- VerifyMode GET/SET
- Network, Server Request ve diğer cihaz iletişim ayarları GET/SET

## Güvenli işlem akışları

### PIN kullanıcısı oluşturma

```text
Connect -> Ping -> Disable (81/0) -> PutEnrollData (98)
-> SaveEnrollData (92) -> Enable (81/1) -> SetUserName (C8)
-> GetUserName (C7) ile doğrula
```

Hata durumunda cihazı yeniden etkinleştirmeyi dene. Doğrulanmamış ayar yazma
komutlarını üretim cihazında çalıştırmadan önce ayrı cihazda capture alın.
