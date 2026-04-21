# Manga Library

로컬 이미지/영상 컬렉션 관리 앱 + Mihon(Tachiyomi) 연동

## 특징

- **Leaf 폴더 감지**: 이미지가 직접 들어있는 폴더만 작품으로 인식
- **다중 루트**: `D:\망가(A~D)`, `D:\망가(N~S)` 등 여러 루트 폴더 등록 가능
- **무한 깊이**: 루트/작가/장르/제목/이미지 어느 구조든 OK
- **Mihon/Tachiyomi 연동**: Komga 소스 + OPDS 피드 동시 지원
- **로컬 HTTP 서버**: 이미지 스트리밍, Range request 지원
- **태그 관리**: 작품별 태그 추가/제거/이름변경
- **별점**: 1~5점 평점
- **내장 뷰어**: 이미지/영상 뷰어, 키보드 조작

## 설치

```bash
# 1. 의존성 설치
npm install

# 2. 실행 (개발)
npm start

# 3. 빌드 (Windows 설치 파일 생성)
npm run build
```

## 폴더 구조 규칙

이미지 파일이 직접 들어있는 **가장 안쪽(leaf) 폴더**가 작품으로 인식됩니다.

```
D:\망가(A~D)\
  └── 작가A\
      ├── 제목1\          ← ✅ 이미지 있음 → 작품: "제목1"
      │     001.jpg
      │     002.jpg
      └── 장르B\
          └── 제목2\      ← ✅ 이미지 있음 → 작품: "제목2"
                001.jpg
```

중간 폴더(작가, 장르 등)에는 이미지가 없으므로 작품이 아닌 **분류 폴더**로 처리됩니다.

## Mihon 연동

### Komga 소스 (권장)

1. Mihon → 탐색 → 확장 → **Komga** 설치
2. Komga 소스 열기
3. 서버 주소: `http://PC_IP:17099`
4. 사용자명: `manga` / 비밀번호: `library`
5. 저장

### OPDS 소스

1. Mihon → 탐색 → OPDS 카탈로그 추가
2. URL: `http://PC_IP:17099/opds`

> PC와 안드로이드가 같은 Wi-Fi에 연결되어 있어야 합니다.
> PC의 IP 주소는 앱 내 **Mihon 연동** 메뉴에서 확인하세요.

## API 엔드포인트

```
GET /api/v1/libraries          — 루트 경로 목록
GET /api/v1/series             — 작품 목록 (page, size, search, library_id)
GET /api/v1/series/:id         — 작품 상세
GET /api/v1/series/:id/books   — 책 목록
GET /api/v1/books/:id/pages    — 페이지 목록
GET /api/v1/books/:id/pages/:n/raw — 페이지 이미지
GET /api/v1/series/:id/thumbnail   — 썸네일
GET /opds                      — OPDS 루트 피드
GET /opds/series/              — 전체 작품 OPDS
GET /opds/search?q=...         — 검색 OPDS
GET /thumb/:id                 — 썸네일 (WebP 변환)
GET /file/:base64path          — 원본 파일 서빙
```

## 기술 스택

- **Electron** — 데스크톱 앱
- **better-sqlite3** — 로컬 DB
- **sharp** — 썸네일 WebP 변환
- **Node.js HTTP** — 내장 미디어 서버 (express 불필요)
- **Komga API 호환** — Mihon Komga 소스와 연동
- **OPDS 1.2** — OPDS 카탈로그 피드
