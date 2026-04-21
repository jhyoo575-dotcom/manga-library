# Manga Library Extension API

## List Response

```json
{
  "page": 0,
  "size": 50,
  "total": 123,
  "hasNextPage": true,
  "items": [
    {
      "id": "1",
      "title": "Title",
      "artist": "Artist",
      "series": "Series",
      "author": "Artist",
      "thumbnailUrl": "http://host/thumb/1",
      "detailUrl": "http://host/mihon/work/1",
      "pagesUrl": "http://host/mihon/work/1/pages",
      "pageCount": 12,
      "hasVideo": false,
      "isRead": false,
      "grade": 0,
      "lastModified": "2026-04-21T00:00:00.000Z"
    }
  ]
}
```

## Detail Response

Same fields as a list item, plus:

```json
{
  "description": "folder path",
  "pageCount": 12,
  "videoCount": 0,
  "status": "completed"
}
```

## Pages Response

```json
{
  "workId": "1",
  "pages": [
    {
      "index": 0,
      "number": 1,
      "fileName": "01.jpg",
      "imageUrl": "http://host/mihon/work/1/pages/1/raw",
      "mediaType": "image/jpeg"
    }
  ]
}
```

