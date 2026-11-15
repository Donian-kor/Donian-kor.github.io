# Donian 개인 포트폴리오 홈페이지

GitHub Pages 기반 정적 포트폴리오 사이트입니다. 17개 GitHub 저장소를 포트폴리오 형식으로 소개합니다.

## 로컬 실행

```bash
# 저장소 루트에서
python -m http.server 8765
# 브라우저에서 http://127.0.0.1:8765 접속
```

> `projects.json`을 fetch로 읽기 때문에 `file://`로 직접 열면 데이터가 로드되지 않습니다. 반드시 로컬 서버를 사용하세요.

## 구조

```
index.html        # 메인 페이지 (단일 파일)
projects.json     # 프로젝트 메타데이터 (추가/삭제는 이 파일만 수정)
assets/images/projects/  # 프로젝트 스크린샷 (WebP)
```

## 프로젝트 추가/삭제 방법

`projects.json`의 `projects` 배열에 항목을 추가하거나 제거하면 페이지에 자동 반영됩니다.

```json
{
  "id": "new-project",
  "name": "NewProject",
  "category": "python",
  "description": "설명",
  "tech": ["Python"],
  "language": "Python",
  "github": "https://github.com/Donian-kor/NewProject",
  "demo": null,
  "screenshot": "assets/images/projects/NewProject.webp",
  "forked": false
}
```

## GitHub Pages 배포

1. GitHub에서 `Donian-kor.github.io` 저장소 생성 (Public)
2. 이 폴더의 파일을 push
3. Settings → Pages → Source: `main` 브랜치 / root
4. `https://donian-kor.github.io`에서 확인

## 라이선스

MIT License