# Джарвис помощник — Codex на Яндекс Станции

«Джарвис» нужен, чтобы разговаривать с Codex через Яндекс Станцию. Например, пока готовите ужин, можно попросить его объяснить, как работает DNS, а потом уточнить: «А как это связано с домашним роутером?» Станция зачитает ответ, а Codex будет помнить предыдущий вопрос.

Скажите «Алиса, запусти навык Джарвис помощник» и задайте вопрос. На обычном Linux-компьютере работает небольшой TypeScript-сервис, который принимает текст от Яндекс Диалогов и передаёт его в Codex. Подойдёт домашний сервер, мини-ПК или Raspberry Pi.

```text
Яндекс Станция → Яндекс Диалоги → HTTPS → TypeScript-сервис → Codex App Server
```

## Чем отличается этот подход

- **Достаточно штатного навыка Алисы.** Станция работает со своей прошивкой. Для сравнения, браузерному мосту Alisa Voice нужны root и SSH на колонке, а список моделей зависит от режима. [Требования Alisa Voice](https://github.com/rison1337/Alisa-ChatGPT-voice-assistant#что-нужно)
- **Запускается сам Codex.** Сервис использует Codex App Server и вход под аккаунтом ChatGPT. Отдельный API-ключ не нужен. У каждого Яндекс ID свой диалог в памяти процесса. Другой подход — передавать запросы модели через OpenAI-совместимый API, как делает Alice LLM Bridge. [Alice LLM Bridge](https://github.com/eluceon/alice-llm-bridge)
- **Быстрые ответы звучат сразу.** Если Codex ещё работает, Алиса подтверждает запрос. Позже можно сказать «Ответ» или повторить вопрос. Для живого разговора без второй реплики при долгой генерации у браузерного голосового моста есть отдельный аудиоканал. [Ожидание ответа от навыка](https://yandex.ru/dev/dialogs/alice/doc/ru/wait-response)

## 1. Установите зависимости на Linux-компьютере

Для запуска понадобятся **Node.js 20 или новее**, **npm**, **Git**, **curl**, **OpenSSL** и **Codex CLI**. Для автозапуска в этой инструкции используется systemd. Яндекс ID нужен для создания навыка, а аккаунт ChatGPT — для входа в Codex.

Пример для Debian 13. В других дистрибутивах установите те же пакеты через свой пакетный менеджер. Если `node --version` показывает версию ниже 20, установите более новую версию Node.js перед сборкой.

```sh
sudo apt update
sudo apt install -y nodejs npm git curl openssl
node --version
npm --version
```

Установите Codex CLI. Пример ниже ставит его в домашний каталог, под тем же Linux-пользователем, от которого будет работать служба. [Другие способы установки Codex](https://github.com/openai/codex#quickstart)

```sh
npm install --global --prefix "$HOME/.local" @openai/codex
export PATH="$HOME/.local/bin:$PATH"
codex --version
codex login
codex login status
codex app-server --help
```

При входе выберите аккаунт ChatGPT. Для этого проекта отдельный API-ключ не нужен.

## 2. Соберите и проверьте вебхук локально

Клонируйте репозиторий или свой форк в `~/alice-codex`. Для текущего приватного репозитория нужно иметь к нему доступ.

```sh
git clone https://github.com/chmaxone/alice-codex.git ~/alice-codex
cd ~/alice-codex
npm ci
npm run build
(umask 077; test -e webhook-token || openssl rand -hex 32 > webhook-token)
npm start
```

В отдельном терминале выполните контрольный запрос. URL передаётся в curl через stdin, чтобы секретный путь не попадал в аргументы процесса.

```sh
cd ~/alice-codex
base_url=http://127.0.0.1:8796
printf 'url = "%s/alice-codex/%s"\n' "$base_url" "$(cat webhook-token)" |
  curl -fsS --max-time 5 --config - \
    -H 'Content-Type: application/json' \
    --data '{"version":"1.0","session":{"skill_id":"local-test","session_id":"smoke","message_id":0,"application":{"application_id":"smoke"}},"request":{"type":"SimpleUtterance","command":"помощь"}}'
```

Должен вернуться JSON с подсказкой «Задайте вопрос» в `response.text`. Остановите ручной запуск через **Ctrl+C** перед включением службы.

## 3. Включите автозапуск

```sh
cd ~/alice-codex
install -m 644 dist/*.mjs .
mkdir -p ~/.config/systemd/user
install -m 644 alice-codex.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now alice-codex
systemctl --user status alice-codex --no-pager
```

Служба использует `/usr/bin/node` и ищет `codex` в своём `PATH`. Если Codex установлен в `~/.local/bin`, как на шаге 1, задайте ему абсолютный путь через `systemctl --user edit alice-codex`. Если Node.js установлен в другом каталоге, там же переопределите `ExecStart`. Пути можно узнать командами `command -v codex` и `command -v node`.

```ini
[Service]
ExecStart=
ExecStart=/абсолютный/путь/к/node %h/alice-codex/server.mjs
Environment=CODEX_BIN=/абсолютный/путь/к/codex
```

После изменения выполните `systemctl --user daemon-reload` и `systemctl --user restart alice-codex`.

Чтобы пользовательская служба запускалась после загрузки компьютера до входа в систему, включите linger командой `sudo loginctl enable-linger "$USER"`.

## 4. Настройте публичный HTTPS

Яндекс Диалогам нужен публичный HTTPS-адрес с доверенным сертификатом. Сервис слушает `127.0.0.1:8796`, а HTTPS принимает прокси на том же компьютере.

Для прямого доступа через домашний роутер проверьте, что у него есть публичный WAN-адрес. Закрепите локальный IP компьютера в DHCP и перенаправьте внешний **TCP 443** на HTTPS-прокси. Для выпуска и продления сертификата через HTTP-01 перенаправьте также **TCP 80**. Если провайдер использует CGNAT, понадобится публичный адрес от провайдера или HTTPS-туннель.

Для примера с доменом создайте DNS-запись `A` на публичный IP и установите Nginx и Certbot. При открытом TCP 80 можно получить сертификат перед добавлением блока HTTPS:

```sh
sudo apt install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
sudo certbot certonly --nginx -d jarvis.example.com
```

На Debian сохраните блок ниже в `/etc/nginx/sites-available/jarvis` и включите его командой `sudo ln -s /etc/nginx/sites-available/jarvis /etc/nginx/sites-enabled/jarvis`. Замените домен, пути к сертификату и при необходимости порт прослушивания под своё перенаправление.

```nginx
server {
    listen 443 ssl;
    server_name jarvis.example.com;

    ssl_certificate     /etc/letsencrypt/live/jarvis.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/jarvis.example.com/privkey.pem;

    access_log off;

    location ^~ /alice-codex/ {
        proxy_pass http://127.0.0.1:8796;
        proxy_connect_timeout 1s;
        proxy_read_timeout 4s;
    }

    location / {
        return 404;
    }
}
```

`proxy_pass` без URI сохраняет исходный путь запроса. После настройки проверьте конфигурацию командой `sudo nginx -t` и примените её через `sudo systemctl reload nginx`. Повторите контрольный запрос из шага 2 с `base_url=https://jarvis.example.com`, по возможности из другой сети. Яндекс требует доверенный сертификат с полной цепочкой. [Требования Яндекс Диалогов к HTTPS](https://yandex.ru/dev/dialogs/alice/doc/ru/publish-settings)

В нашем домашнем развёртывании вместо домена использовался публичный IPv4 с сертификатом Let’s Encrypt на IP. Для такого сертификата нужно настроить автоматическое продление. При смене WAN-адреса придётся выпустить сертификат для нового IP и обновить вебхук. [Сертификаты на IP в Certbot](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html)

## 5. Подключите навык Яндекс Диалогов

1. Откройте [консоль Яндекс Диалогов](https://dialogs.yandex.ru/developer/). Нажмите **Создать диалог → Навык в Алисе**.
2. Задайте имя и пример активации, например **«Запусти навык Джарвис помощник»**. В типе доступа выберите **Приватный**. Добавьте **Яндекс Станцию** в доступные поверхности и выключите требование экрана.
3. В **Backend → Webhook URL** укажите `https://jarvis.example.com/alice-codex/<токен>`. Подставьте содержимое локального файла `webhook-token`. URL содержит секрет. Не публикуйте его в статье, скриншотах или журнале прокси.
4. Сохраните черновик. Во вкладке **Тестирование** включите режим **Нет экрана**, задайте вопрос и при необходимости отправьте **«Ответ»**.
5. Заполните обязательные поля публикации, включая описание и иконку. Отправьте навык на автомодерацию, нажмите **Опубликовать** и дождитесь появления опубликованной версии.
6. На Станции скажите **«Алиса, запусти навык Джарвис помощник»**. Если колонка привязана к другому Яндекс ID, выдайте этому аккаунту доступ через одноразовую ссылку во вкладке **Доступ**.

[Создание и проверка навыка](https://yandex.ru/dev/dialogs/alice/doc/ru/skill-create-console) · [Доступ к приватному навыку](https://yandex.ru/dev/dialogs/alice/doc/ru/access)

## Свой системный промпт

`CODEX_SYSTEM_PROMPT` полностью заменяет встроенные инструкции Codex для голосового диалога. Если переменная отсутствует, используются встроенные инструкции. Пустое значение передаёт пустую инструкцию.

Для ручного запуска задайте переменную перед командой:

```sh
CODEX_SYSTEM_PROMPT='Отвечай по-русски, короткими фразами без Markdown.' npm start
```

Для автозапуска откройте `systemctl --user edit alice-codex` и добавьте в секцию `[Service]`:

```ini
[Service]
Environment="CODEX_SYSTEM_PROMPT=Отвечай по-русски, короткими фразами без Markdown."
```

Перезапустите службу командой `systemctl --user restart alice-codex`. Новый промпт применяется к новым диалогам.

## Как работает диалог

- Первый вопрос открывает диалог. Навык сразу подтверждает приём, а Codex готовит ответ в фоне.
- В открытом диалоге навык ждёт до **3,3 секунды**. Если Codex успел, Алиса сразу озвучивает ответ. Для более долгих запросов скажите **«Ответ»** или повторите тот же вопрос. Готовый результат при повторе вопроса используется в течение **45 секунд**.
- Для свежих сведений Codex может использовать встроенный веб-поиск. Ответы с поиском обычно требуют больше времени.
- Контекст хранится в памяти фонового процесса. Перезапуск службы начинает новые диалоги. Яндекс ожидает полный ответ вебхука за **4,5 секунды**, включая сеть. [Формат ответа Алисы](https://yandex.ru/dev/dialogs/alice/doc/ru/response)

## Обновление и диагностика

```sh
cd ~/alice-codex
git pull --ff-only
npm ci
npm run build
install -m 644 dist/*.mjs .
systemctl --user restart alice-codex
journalctl --user -u alice-codex -n 30 --no-pager
```

Если в консоли работает черновик, а на колонке появляется «Навык не отвечает», проверьте URL именно **опубликованной версии** и её вкладку **Мониторинг**. Если запрос есть в журнале службы, строки `Webhook response` и `Codex completed` показывают время ответа вебхука и длительность работы Codex.
