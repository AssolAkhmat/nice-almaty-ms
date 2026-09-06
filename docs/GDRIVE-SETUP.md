# Google Drive: как получить ключи

Инструкция для владельца. Делается один раз, занимает около десяти минут.
До того как она выполнена, `STORAGE_DRIVER` остаётся `local` — приложение
работает, файлы лежат на диске сервера.

Почему именно так, а не через сервисный аккаунт: у сервисного аккаунта Google
нет собственной квоты хранилища, и загрузка в папку личного диска падает
с `storageQuotaExceeded`. Решение D3 в `docs/08-DECISIONS.md`.

## 1. Проект и согласие

1. https://console.cloud.google.com → создайте проект (или возьмите существующий).
2. «APIs & Services» → «Library» → включите **Google Drive API**.
3. «APIs & Services» → «OAuth consent screen»:
   - тип **External**, если аккаунт обычный (не Workspace);
   - заполните название и контактный e-mail;
   - в «Test users» добавьте **тот самый аккаунт**, на диске которого будут лежать файлы;
   - публиковать приложение не нужно: режим «Testing» достаточен, но `refresh_token`
     в нём живёт **семь дней**. Для постоянной работы нажмите «Publish app» —
     проверка Google не требуется, пока используется только область `drive.file`.

## 2. Учётные данные

«APIs & Services» → «Credentials» → «Create credentials» → «OAuth client ID»:

- тип приложения — **Desktop app**;
- полученные `Client ID` и `Client secret` кладутся в `GDRIVE_CLIENT_ID`
  и `GDRIVE_CLIENT_SECRET`.

## 3. Одноразовая авторизация

Область запрашивается ровно одна — `https://www.googleapis.com/auth/drive.file`.
Она даёт доступ только к тем файлам, которые создало само приложение:
остальной диск для него не существует.

Откройте в браузере, подставив свой `client_id`:

```
https://accounts.google.com/o/oauth2/v2/auth?client_id=<client_id>&redirect_uri=http://localhost&response_type=code&scope=https://www.googleapis.com/auth/drive.file&access_type=offline&prompt=consent
```

Войдите тем аккаунтом, на диске которого будут файлы, и разрешите доступ.
Браузер уйдёт на `http://localhost/?code=...` и покажет ошибку соединения —
это нормально, нужен только `code` из адресной строки.

Обменяйте код на токены:

```bash
curl -s https://oauth2.googleapis.com/token \
  -d client_id=<client_id> \
  -d client_secret=<client_secret> \
  -d code=<code> \
  -d grant_type=authorization_code \
  -d redirect_uri=http://localhost
```

Из ответа нужен `refresh_token` — он кладётся в `GDRIVE_REFRESH_TOKEN`.
Выдаётся он только при `access_type=offline` и `prompt=consent`; если в ответе
его нет, отзовите доступ приложения в настройках аккаунта и повторите шаг.

## 4. Корневая папка

Создайте в «Мой диск» папку для файлов приложения и откройте её.
Идентификатор — хвост адреса `https://drive.google.com/drive/folders/<id>` —
кладётся в `GDRIVE_ROOT_FOLDER_ID`.

Внутри приложение само заведёт структуру `/{house_slug}/{residency_id}/{document_type}/`.

## 5. Включение

```env
STORAGE_DRIVER=gdrive
GDRIVE_CLIENT_ID=
GDRIVE_CLIENT_SECRET=
GDRIVE_REFRESH_TOKEN=
GDRIVE_ROOT_FOLDER_ID=
```

Без любого из четырёх значений приложение не стартует и назовёт недостающее.

Проверка после запуска — `GET /api/health`: раздел `storage` должен ответить
`{"status":"ok","driver":"gdrive"}`. Ответ `error` содержит причину целиком,
включая текст отказа Google.

## Чего эта настройка не делает

Публичные ссылки на файлы не выдаются никогда: права на объекты Drive приложение
не меняет, запросов к `permissions` в драйвере нет. Содержимое отдаётся только
через `GET /api/v1/files/{id}/content`, который проверяет права
(`docs/01-ARCHITECTURE.md`).
