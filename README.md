[![-----------------------------------------------------](https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/colored.png)](#table-of-contents)
# Baileys Up To Date
 
 <p align="center">
<img width="" src="https://img.shields.io/github/repo-size/amiruldev20/baileys?color=green&label=Repo%20Size&style=for-the-badge&logo=appveyor">
</p>

 > **Warning**: ini hanyalah repo baileys yang sudah ter update & fix jika ada problem. memudahkan bagi pemula jika ada pull req di repo utama yang belum di acc
 
 > **Note**: kalau ada problem atau masalah, tanya2 ke grup dibawah ini
 
 
GRUP INFO BAILEYS: [KLIK DISINI](https://chat.whatsapp.com/Htfi5uzYWOt0ekPu66YK4Y)

#### update an sementara diberhentikan, sedang mengupdate library lainnya dan base baru direpo ini

### baca semua keterangan dibawah biar tahu

## 🔥 connection options
> **Note**: setting tambahan connection option seperti dibawah ini terlebih dahulu
```
const connectionOptions = {
printQRInTerminal: true, // memunculkan qr di terminal
syncFullHistory: false, // menerima riwayat lengkap
markOnlineOnConnect: false, // membuat wa bot of, true jika ingin selalu menyala
connectTimeoutMs: 60_000, // atur jangka waktu timeout
defaultQueryTimeoutMs: 0, // atur jangka waktu query (0: tidak ada batas)
keepAliveIntervalMs: 10000, // interval ws
generateHighQualityLinkPreview: true, // menambah kualitas thumbnail preview
// patch dibawah untuk tambahan jika hydrate/list tidak bekerja
patchMessageBeforeSending: (message) => {
    const requiresPatch = !!(
        message.buttonsMessage 
        || message.templateMessage
        || message.listMessage
    );
    if (requiresPatch) {
        message = {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadataVersion: 2,
                        deviceListMetadata: {},
                    },
                    ...message,
                },
            },
        };
    }

    return message;
},
getMessage: async (key) => {
         if (store) {
            const msg = await store.loadMessage(key.remoteJid, key.id)
            return msg.message || undefined
         }
         return {
            conversation: "hello, i'm Amirul Dev"
         }
      },
// get message diatas untuk mengatasi pesan gagal dikirim, "menunggu pesan", dapat dicoba lagi
}
```
