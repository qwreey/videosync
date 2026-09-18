# 실사용 테스트 가이드 (2026-09-18)

아는 사람들과 실제로 써 보면서 문제를 모으기 위한 문서다. 서버를 띄우고, 인증을 붙이고,
확장을 빌드해 나눠 주고, 무엇을 해 보고, 무엇을 가져와야 하는지를 적는다.

정적 리뷰와 에이전트 리뷰는 거의 수렴했다 (`docs/REVIEW-NEXT.md`). 남은 위험은 대부분 실측에서
나온다: 여러 네트워크, 실제 사람의 조작, 사이트가 알아서 하는 일, 브라우저 차이.
이 문서의 목표는 그런 경우를 **조건과 함께** 쌓아 오는 것이다. 한 건씩 넘기지 말고 모아서 넘긴다.

- 서버 플래그 전체 목록은 `videosyncd -h`에서 볼 수 있다.
- 인증 설계는 `docs/design/auth.md`, 프로바이더 설명은 `docs/design/providers.md`에 있다.
- 짧은 소개는 `README.md`에 있다.

---

## 1. 서버 배포 (Docker)

### 알아 둘 것부터

- **서버는 환경변수를 읽지 않는다.** 설정은 전부 명령줄 플래그로 받고, 비밀값(OIDC client secret,
  토큰 목록, 사용자 파일, 기기 토큰 서명 키)은 전부 **파일 경로**로 받는다. Docker에서는 비밀 파일을
  볼륨이나 `secrets:`로 마운트하고 그 경로를 플래그에 넘긴다.
- 서버 하나에 프로세스 하나다. 방 정보는 메모리에만 있어서 재시작하면 모든 방이 사라진다.
  여러 인스턴스를 띄워도 방을 공유하지 않는다.
- 이미지는 `server/Dockerfile`로 빌드한다. `scratch` 베이스이고 사용자는 `65534`이며,
  마운트한 파일은 읽을 수만 있으면 된다.
- **실측 기간에는 `-verbose`를 켠다.** 켜지 않으면 서버가 연결별로 아무것도 남기지 않는다.
  그러면 클라이언트가 보내지 않은 프레임과 서버가 버린 프레임을 구분할 수 없다.
  로그에는 이름, 채팅, 영상 URL이 들어간다(교체된 방 비밀키는 가려짐). 참가자들에게 미리 알린다.

### 공개 주소가 필요한가

| 누가 쓰는가 | 서버 위치 |
|---|---|
| 모두 **확장**만 쓴다 | 어디든 된다. 루프백, LAN, tailnet 모두 가능하다 (확장의 service worker는 제한을 받지 않는다) |
| **userscript** 사용자가 있다 | **공개 도메인에 진짜 인증서가 붙은 https**여야 한다. Chromium에서는 공개 사이트 페이지가 사설/루프백 주소로 요청을 아예 보내지 못한다. 요청이 브라우저를 떠나지 않아 서버가 꺼진 것처럼 보인다 (`BROWSER-FINDINGS` §8, §9) |

Firefox는 이 제한이 없지만(§19), 섞어 쓰는 것을 생각하면 **공개 https**로 가는 편이 간단하다.

### compose 예시 (Caddy가 TLS를 맡는 경우)

`deploy/docker-compose.yml`이 기본 틀이다. 실측용으로 늘리면 아래와 같다. 서버는 내부망에만 열고
Caddy만 밖으로 연다.

```yaml
services:
  videosyncd:
    build: ../server              # 또는 미리 빌드한 image
    restart: unless-stopped
    command:
      - -addr=:8787
      - -verbose
      - -public-url=https://sync.example.com
      - -trusted-proxies=172.16.0.0/12      # Caddy 컨테이너가 들어오는 대역 (docker network)
      - -allowed-origins=https://www.youtube.com, https://m.youtube.com, https://laftel.net, chrome-extension://*, moz-extension://*
      - -auth-key-file=/secrets/device.key
      - -providers=/providers
      # 인증 방식별 플래그는 아래 2절
    volumes:
      - ./providers:/providers:ro
      - ./secrets:/secrets:ro
    expose: ["8787"]

  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
volumes:
  caddy-data:
```

```caddy
sync.example.com {
    reverse_proxy videosyncd:8787
}
```

Caddy의 `reverse_proxy`는 `X-Forwarded-For`, `X-Forwarded-Proto`, `Host`를 기본으로 넘겨 준다.
WebSocket(`/ws`)도 별도 설정 없이 통과한다.

**반드시 확인할 것**

1. **`-public-url`**: 브라우저가 서버에 닿는 origin이다. 경로 없이 루트여야 한다.
   - 없으면 로그인 링크를 요청의 `Host`로 만든다.
   - nginx 기본값이면 `127.0.0.1:8787`이 되어, 로그인 탭이 방문자 자기 컴퓨터를 연다.
   - OIDC에서는 필수다.
2. **`-trusted-proxies`**: 프록시의 주소 또는 CIDR이다.
   - 없으면 모든 요청이 프록시 한 대에서 온 것으로 보여, 속도 제한을 모두가 함께 맞는다.
   - 프록시가 `X-Forwarded-For`와 `X-Real-IP`를 둘 다 보내는데 서로 다르면 프록시 자신에게 청구된다.
3. **`-allowed-origins`**: 확장은 **사이트가 아니라 자기 origin**(`chrome-extension://…`,
   `moz-extension://…`)으로 요청한다. 사이트만 적으면 확장 사용자 전원이 막히고 userscript만
   동작한다. 서버가 시작할 때 경고한다. 패턴은 `*`와 `<확장 scheme>://*`만 된다.
   `https://*.example.com`은 아무것에도 맞지 않는다.
4. **`-auth-key-file`**: `openssl rand -hex 32 > secrets/device.key`로 만든다.
   - 없으면 서버를 재시작할 때마다 모든 기기가 다시 로그인해야 한다.
   - 파일을 바꾸면 모든 기기가 로그아웃된다.
5. 동작 확인: `curl https://sync.example.com/healthz`에서 `ok`와 켜진 인증 방식이 보여야 한다.

로그 보기: `docker compose logs -f videosyncd`. `scratch` 이미지에는 시간대 정보가 없어서 로그 시각은
UTC다. 보고할 때 시간대를 같이 적는다.

---

## 2. 인증 경로

`-auth`에 쉼표로 여러 방식을 켤 수 있고, 하나만 통과하면 된다. 로그인은 **항상 서버 자신의
`/auth/login` 탭**에서 한다. 패널은 비밀번호나 키를 받지 않는다(사이트 DOM 안에 있어서 사이트가
읽을 수 있기 때문이다). 기기 하나에 한 번 로그인하면 기기 토큰이 확장 쪽에 저장된다.

- `-auth-scope create`(기본): 방 **만들기**만 로그인이 필요하다. 초대 링크를 받은 사람은 계정 없이 들어온다.
  이때는 방 비밀키가 자격 증명이다.
- `-auth-scope all`: 참가에도 로그인이 필요하다.

### 2a. 인증 없음 (tailnet, LAN)

`-auth none`(기본). 서버에 닿을 수 있으면 누구나 방을 만든다. tailscale 안에서만 쓰는 경우에 맞다.

### 2b. token / password

```
-auth=token    -auth-tokens-file=/secrets/keys.txt        # 한 줄에 키 하나, 또는 sha256:<hex>
-auth=password -auth-users-file=/secrets/users.txt        # videosyncd hash-password <이름> 으로 생성
```

사용자 파일 만들기 (비밀번호는 stdin으로):

```bash
docker run --rm -i videosyncd hash-password alice >> secrets/users.txt
```

PBKDF2-SHA256 형식이라 htpasswd/bcrypt 파일은 쓸 수 없다. 이름이 `#`로 시작하거나 앞뒤에 공백이
있으면 거부된다.

### 2c. 프록시 / forward-auth (authentik, Authelia, tinyauth, oauth2-proxy, Basic auth)

게이트웨이가 로그인을 맡고, videosyncd는 **신뢰하는 프록시가 보낸 요청**을 로그인한 것으로 본다.

```
-auth=proxy
-trusted-proxies=<게이트웨이/프록시 주소>
-auth-user-header=<게이트웨이가 사용자 이름을 넣는 헤더>   # 선택. 없으면 프록시를 거친 것 자체로 인정
```

**게이트웨이로 막을 경로는 딱 두 개다: `/api/session`, `/auth/`.**
나머지(`/ws`, `/healthz`, `/api/rooms`, `/api/ticket`, `/api/auth/`, `/api/providers`, 그리고
**모든 `OPTIONS` 요청**)는 **열어 둬야 한다.** 이 경로들은 서버가 직접 검사한다. 프록시가 preflight를
막으면 확장과 userscript가 "Failed to fetch"라는 메시지만 남기고 실패한다.

Caddy 예시 (forward_auth 대상은 각 소프트웨어의 문서 그대로):

```caddy
sync.example.com {
    @login path /api/session /auth/*
    handle @login {
        forward_auth authentik-server:9000 {        # 또는 authelia/tinyauth/oauth2-proxy
            uri /outpost.goauthentik.io/auth/caddy
            copy_headers X-authentik-username       # 게이트웨이가 돌려주는 사용자 헤더
        }
        reverse_proxy videosyncd:8787
    }
    handle {
        reverse_proxy videosyncd:8787
    }
}
```

`-auth-user-header`는 게이트웨이가 넣어 주는 헤더 이름과 같아야 한다. 흔히 쓰는 이름은 아래와 같다.
정확한 이름은 쓰는 소프트웨어의 문서에서 확인한다.

| 게이트웨이 | 흔한 헤더 |
|---|---|
| authentik (proxy outpost) | `X-authentik-username` |
| Authelia | `Remote-User` |
| tinyauth | `Remote-User` |
| oauth2-proxy (`--set-xauthrequest`) | `X-Auth-Request-User` (또는 `X-Forwarded-User`) |

유의사항:

- **방문자가 보낸 같은 이름의 헤더를 프록시가 반드시 덮어써야 한다.** 그렇지 않으면 누구나 그 헤더를
  넣어 로그인한 척할 수 있다. 위 Caddy 예시처럼 `/api/session`, `/auth/`에서만 복사하면 된다.
- **서버는 프록시를 거치지 않고는 접근할 수 없어야 한다.** compose에서 `expose`만 쓰고 `ports`로
  공개하지 않는다.
- 게이트웨이가 확장의 요청에 로그인 페이지(리다이렉트, HTML)나 401/403/407로 답하면, 확장은
  "탭에서 로그인하라"로 받아들여 서버의 로그인 탭을 연다. 사용자는 그 탭에서 게이트웨이에 로그인하고
  확인 버튼을 누른다. 게이트웨이의 5xx나 404는 장애로 보고 재시도한다.
- `/api/session`에서 프록시를 믿는 것은 `X-VideoSync-Device` 헤더가 있는 요청뿐이고, 이 헤더는
  확장 origin의 preflight에서만 허용된다. 그래서 게이트웨이가 허용한 네트워크의 아무 페이지나
  기기 토큰을 발급받을 수는 없다.
- 확장 백그라운드의 fetch가 게이트웨이 쿠키나 캐시된 Basic 인증을 보내는지는 아직 측정하지 않았다.
  설계상 쿠키에 의존하지 않고 항상 탭 로그인으로 가지만, 실측에서 확인해 볼 부분이다.

### 2d. OIDC (authentik, Keycloak, Google, Entra 등)

videosyncd가 직접 relying party가 된다.

```
-auth=oidc
-public-url=https://sync.example.com
-oidc-issuer=https://idp.example.com/application/o/videosync/   # IdP가 스스로 부르는 issuer 문자열 그대로
-oidc-client-id=videosync
-oidc-client-secret-file=/secrets/oidc-secret.txt
-oidc-allow=email:you@example.com,group:friends                 # 선택. 비우면 IdP가 받아 준 모두
```

IdP 쪽 등록:

- 유형: **confidential client**, authorization code flow.
- Redirect URI: **`https://sync.example.com/auth/oidc/callback`** (`-public-url` + `/auth/oidc/callback`).
- Scope: 서버가 `openid email profile`을 요청한다. `-oidc-allow`에 `group:`이 있을 때만 `groups`를
  추가로 요청하니, 그때는 IdP가 `groups` scope와 `groups` 클레임을 내주도록 설정한다.
- 사용자 이름은 `preferred_username`, 없으면 `email`, 없으면 `sub` 순서로 쓴다.
- `email:` 허용은 IdP가 **`email_verified: true`** 를 줄 때만 맞는다. Entra ID처럼 이 값을 주지 않는
  IdP는 `sub:`이나 `group:`으로 허용한다.

유의사항:

- issuer 문자열은 끝의 `/`까지 IdP의 discovery 문서와 정확히 같아야 한다.
- ID 토큰은 TLS로 토큰 엔드포인트에서 직접 받고 클레임을 검사한다. **JWKS 서명 검증은 아직 하지 않는다**
  (알려진 미결).
- 로그인 시작(`/auth/oidc/start`)은 다른 사이트에서 연 요청을 거부한다. 서버의 로그인 탭에서 버튼을
  눌러 시작한다.

---

## 3. 클라이언트 빌드와 배포

```bash
mise install                                    # go, node 버전 고정
cd client/extension && npm install && npm run build
#  → client/extension/dist          (Chrome/Edge/Brave/Helium, MV3)
#  → client/extension/dist-firefox  (Firefox, MV2)
cd ../userscript && npm install && npm run build
#  → client/userscript/dist/videosync.user.js
```

사이트 목록은 `providers/*.json`에서 만들어진다. 기본은 YouTube와 Laftel이다.
새 사이트를 기본 지원에 넣으려면 파일을 추가하고 다시 빌드한다. 서버가 제공하는 설명을 쓰려면
확장 옵션 페이지에서 **채택**하고 사이트 권한을 준다.

### Chrome 계열

`chrome://extensions` → 개발자 모드 → **압축해제된 확장 프로그램을 로드합니다** → `dist` 폴더를 고른다.
빌드를 새로 받으면 같은 자리에서 새로고침한다.
새로고침 뒤 동작이 이상하면 service worker가 예전 것으로 남았을 수 있다
(`CLAUDE.md` "Live-run setup traps"). 확장을 제거하고 다시 로드한다.

### Firefox

- `about:debugging` → 이 Firefox → **임시 부가 기능 로드** → `dist-firefox/manifest.json`을 고른다.
  임시 부가 기능은 **Firefox를 재시작하면 사라진다.** 며칠 쓰려면 아래 둘 중 하나를 쓴다.
  - Developer Edition 또는 Nightly에서 `xpinstall.signatures.required=false`로 두고 `dist-firefox`를
    zip으로 묶어 설치한다.
  - AMO에 비공개(unlisted)로 서명받아 배포한다.
- Firefox 빌드는 MV2다. MV3 백그라운드는 `ws://`를 열지 못한다(TLS로 바꿔 보냄, close 1015).
- 전체화면에서 패널이 보이려면 Popover API가 필요하다(Firefox 125 이상). 그보다 낮은 버전에서는
  전체화면인 동안 패널과 배너가 보이지 않는다.

### userscript (Tampermonkey / Violentmonkey)

`dist/videosync.user.js`를 설치한다.

- 서버가 **공개 https**여야 한다 (1절).
- 처음 서버에 요청할 때 Tampermonkey가 그 도메인을 허용할지 묻는다 (`@connect *`).
- Violentmonkey는 `@inject-into content`를 지켜야 한다. 스크립트에 들어 있으니 사용자 설정으로
  바꾸지 않는다. 바꾸면 방 비밀키와 기기 토큰을 페이지가 읽을 수 있다.
- 실제 Tampermonkey/Violentmonkey에서는 아직 돌려 보지 않았다. 게이트웨이 리다이렉트를 판정하는
  방식(`onload`의 status 0)도 측정 대상이다.

### 처음 쓰는 흐름

1. 패널에 서버 주소와 이름을 넣고 **방 만들기**를 누른다. 로그인이 필요하면 로그인 탭이 열린다.
2. **초대 링크 복사**로 링크를 보낸다. 받은 사람은 링크를 열고 **참가**를 누른다.
3. 받은 사람은 어디서 열었든 방의 영상으로 이동한다. 누군가 다른 화로 옮기면 모두 함께 옮긴다.

---

## 4. 해 볼 것 (조건별 체크리스트)

결과는 "무엇을 했고, 무엇을 기대했고, 무엇을 봤는지"와 아래 5절의 자료를 함께 남긴다.

**기본 동기화**
- 각 사람이 번갈아 재생, 정지, 탐색(짧게, 길게, 버퍼 밖으로)을 한다. 다른 사람들이 따라오는지,
  누른 사람 화면이 튀는지 본다.
- 몇 분 동안 그대로 둔다. 조금씩 벌어지는지, 벌어졌다가 돌아오는지 본다.
- 브라우저를 섞는다(Chrome + Firefox). Firefox + Laftel 조합에서는 200–300 ms 정도 늘 벌어져 있는 것이 알려져 있다.

**영상 이동**
- 다른 사이트에서 초대 링크로 참가하면 방의 영상으로 이동하는지 본다.
- 다음 화 자동 재생(Laftel)에서 모두 함께 넘어가는지, 누가 늦게 도착하면 기다리는지 본다.
- 혼자 다른 화로 가면 끌려오지 않고, "이 영상으로 방 옮기기"가 나오는지 본다.

**네트워크** (이번 실측에서 가장 기대하는 부분)
- 와이파이 끄기/켜기, 모바일 핫스팟, VPN이나 tailscale 경유, 먼 거리(해외), 느린 회선.
- 끊긴 동안: 패널에 **"연결이 끊겼어요"** 배너가 뜨는지, 끊긴 동안 누른 것이 방에 **전해지지 않는지**,
  다시 연결되면 방 상태로 돌아오는지 본다.
  - 이것은 결정된 동작이다. 끊긴 동안의 조작은 버린다.
  - 알려진 구멍: 소리 없이 끊긴 경로에서는 15–20초 동안 아직 "연결됨"으로 보인다.
- 노트북 덮개를 닫았다 열기, 네트워크 전환(와이파이 ↔ 유선) 뒤에 얼마 만에 다시 붙는지 본다.
  - 여는 중인 소켓에는 시간 제한이 없어서 오래 걸릴 수 있다. 측정 대상이다(`REVIEW-NEXT` F4).

**탭과 화면**
- 백그라운드 탭에서 참가한다. 숨은 탭 때문에 다른 사람의 재생이 막히지 않아야 한다.
- 전체화면: 패널이 **제목과 배너만** 남은 읽기 전용이 되는지 본다.
  - 전체화면에서는 패널을 누를 수 없고, 누르면 사이트 플레이어가 반응한다. 측정된 한계다.
  - YouTube 전체화면은 아직 측정하지 않았다.
- 패널 접기와 펴기, 드래그로 옮기기.

**인증**
- 켜 둔 방식마다 새 기기에서 로그인하고, 서버를 재시작해도 로그인이 유지되는지 본다
  (`-auth-key-file`을 쓴 경우).
- 게이트웨이 세션이 만료된 뒤 다시 방을 만들어 본다.
- 초대 링크로 계정 없이 참가한다(`-auth-scope create`).
- 비밀키 교체 뒤 예전 링크로는 못 들어오는지, 이미 들어와 있는 사람은 그대로인지 본다.

---

## 5. 문제가 생겼을 때 가져올 것

1. **시각**(시간대 포함)과 **누가 무엇을 눌렀는지**.
2. **클라이언트 진단**: 문제가 난 탭의 패널 맨 아래 **"진단 정보 복사"**를 누르고, 복사된 내용을
   메신저에 그대로 붙여 넣어 보낸다.
   - 들어 있는 것: 엔진 상태, 최근 프레임 기록, 플레이어 상태, 프로바이더 정보.
   - **토큰과 방 비밀키는 들어 있지 않다.** 프레임 기록은 정해진 필드(seq, 위치, 종류, 미디어 키·URL 등)만
     남기고, 주소창의 초대 비밀키는 가려진다.
   - 문제가 난 **직후에** 눌러도 된다. 기록은 항상 남고 있다.
   - 자동 복사가 막히면 패널에 텍스트 칸이 열린다. 그 칸의 내용을 전부 복사해서 보낸다.
   - 전체화면에서는 패널을 누를 수 없다. 전체화면에서 나온 뒤에 누른다.
   - 개발자라면 콘솔의 실행 컨텍스트를 **VideoSync**로 바꾸고 `copy(VideoSync.dump())`를 실행해도
     같은 내용을 얻는다.
3. **서버 로그**: 같은 시각 전후의 `docker compose logs videosyncd` (`-verbose`).
4. 환경: 브라우저와 버전, 확장인지 userscript인지, OS, 네트워크 종류(와이파이, 핫스팟, VPN), 사이트와 영상 URL.
5. 가능하면 화면 녹화.

이번 실측은 **Chrome 계열 + 확장** 경로로 한다. Firefox는 DRM(Widevine) 설정과 부가 기능 설치가
까다로워서, 나중에 개발자들을 모아 따로 테스트한다.

---

## 6. 이미 알고 있는 것 (보고하지 않아도 되는 것)

아래는 결정했거나 이미 측정한 한계다. 다른 조건에서 다르게 나오면 그것은 보고한다.

- 끊긴 동안 누른 재생·정지·탐색은 방에 전해지지 않는다. 다시 연결되면 방이 이긴다.
- 소리 없이 끊긴 경로에서는 15–20초 동안 배너 없이 "연결됨"으로 보인다.
- 끊긴 동안 영상 끝까지 가 버린 사람은 끝에 남는다(방은 계속 재생).
- 전체화면에서는 패널이 읽기 전용이다. Popover API가 없는 브라우저(Firefox 125 미만)에서는 전체화면인
  동안 패널이 보이지 않는다.
- Firefox + Laftel은 늘 200–300 ms 정도 벌어진 채로 유지된다. 탐색 직후 약 1초 동안 위치가 멈춰
  읽혀서 교정이 한 번 더 들어올 수 있다.
- 광고는 처리하지 않는다.
- http 전용 사이트는 프로바이더 설명으로 따라가게 할 수 없다(watch URL은 https만).
- 같은 프로필의 두 탭이 동시에 따라가면 재참가 기록을 공유한다.
- OIDC의 JWKS 서명 검증은 없다.
- userscript는 공개 https 서버에서만 된다(Chromium).
- 서버를 재시작하면 모든 방이 사라진다.
