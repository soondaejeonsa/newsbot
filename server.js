// 뉴스봇아이디로 방송 채팅에 뉴스 쏘기, 15분마다 방송검색 방송종료까지 검색안함
import express from "express";
import fetch from "node-fetch";
import xml2js from "xml2js";
import { google } from "googleapis";

const app = express();

const PORT = process.env.PORT || 8080;

// ======================================================
// 설정
// ======================================================

// 순대전사 채널
const TARGET_CHANNEL_ID =
  "UChqJ-rp_I9NKwZOtzI11jNw";

// Google News RSS
const GOOGLE_NEWS_RSS =
  "https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko";

// 뉴스 전송 주기: 1분
const NEWS_INTERVAL = 60 * 1000;

// 라이브가 없을 때만 라이브 검색
// 15분 = 하루 최대 96회
const NO_LIVE_CHECK_INTERVAL = 15 * 60 * 1000;

// ======================================================
// Express
// ======================================================

app.get("/", (req, res) => {
  res.send("YouTube Google News Bot is running.");
});

// ======================================================
// Google 인증
// ======================================================

let youtube = null;

try {

  if (!process.env.YOUTUBE_CLIENT_ID) {
    throw new Error(
      "YOUTUBE_CLIENT_ID가 없습니다."
    );
  }

  if (!process.env.YOUTUBE_CLIENT_SECRET) {
    throw new Error(
      "YOUTUBE_CLIENT_SECRET이 없습니다."
    );
  }

  if (!process.env.YOUTUBE_REFRESH_TOKEN) {
    throw new Error(
      "YOUTUBE_REFRESH_TOKEN이 없습니다."
    );
  }

  const oauth2Client =
    new google.auth.OAuth2(
      process.env.YOUTUBE_CLIENT_ID,
      process.env.YOUTUBE_CLIENT_SECRET,
      "http://localhost"
    );

  oauth2Client.setCredentials({
    refresh_token:
      process.env.YOUTUBE_REFRESH_TOKEN
  });

  youtube = google.youtube({
    version: "v3",
    auth: oauth2Client
  });

  console.log(
    "✅ YouTube API 인증 설정 완료"
  );

} catch (error) {

  console.error(
    "❌ YouTube 인증 설정 실패:"
  );

  console.error(
    error.message
  );
}

// ======================================================
// RSS Parser
// ======================================================

const parser =
  new xml2js.Parser({
    explicitArray: false
  });

// ======================================================
// 이미 보낸 뉴스
// ======================================================

const sentNews = new Set();

const MAX_SENT_NEWS = 500;

// ======================================================
// 현재 라이브 정보
// ======================================================

let currentVideoId = null;
let currentLiveChatId = null;

// 현재 라이브가 없는 상태인지
let liveActive = false;

// 라이브가 없을 때 마지막 검색 시간
let lastLiveSearchTime = 0;

// ======================================================
// Google News 가져오기
// ======================================================

async function fetchGoogleNews() {

  try {

    const response =
      await fetch(
        GOOGLE_NEWS_RSS,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0"
          }
        }
      );

    if (!response.ok) {

      throw new Error(
        `Google News RSS 오류: ${response.status}`
      );

    }

    const xml =
      await response.text();

    const result =
      await parser.parseStringPromise(
        xml
      );

    let items =
      result?.rss?.channel?.item || [];

    if (!Array.isArray(items)) {
      items = [items];
    }

    const news =
      items
        .filter(
          item =>
            item &&
            item.title
        )
        .map(item => {

          let title =
            item.title;

          let link = "";

          if (
            typeof item.link ===
            "string"
          ) {

            link =
              item.link;

          } else if (
            item.link?._
          ) {

            link =
              item.link._;

          }

          // --------------------------------------------
          // 제목에서 언론사 분리
          // --------------------------------------------

          let source = "";

          if (
            title.includes(" - ")
          ) {

            const parts =
              title.split(" - ");

            source =
              parts
                .pop()
                .trim();

            title =
              parts
                .join(" - ")
                .trim();

          }

          // --------------------------------------------
          // 뉴스 고유 ID
          // --------------------------------------------

          const id =
            item.guid ||
            link ||
            `${title}|${source}`;

          return {
            id,
            title,
            source,
            link
          };

        });

    return news;

  } catch (error) {

    console.error(
      "❌ Google News 가져오기 실패:",
      error.message
    );

    return [];
  }
}

// ======================================================
// 순대전사의 현재 라이브 찾기
// ======================================================

async function findCurrentLive() {

  if (!youtube) {

    throw new Error(
      "YouTube API가 초기화되지 않았습니다."
    );

  }

  // --------------------------------------------
  // 라이브 검색 간격 제한
  // --------------------------------------------

  const now = Date.now();

  if (
    now - lastLiveSearchTime <
    NO_LIVE_CHECK_INTERVAL
  ) {

    return currentLiveChatId;

  }

  lastLiveSearchTime = now;

  try {

    console.log(
      "🔎 순대전사 현재 라이브 검색..."
    );

    // --------------------------------------------
    // 순대전사 채널에서 LIVE 영상 검색
    // --------------------------------------------

    const searchResponse =
      await youtube.search.list({

        part:
          "id,snippet",

        channelId:
          TARGET_CHANNEL_ID,

        eventType:
          "live",

        type:
          "video",

        maxResults:
          1

      });

    const items =
      searchResponse.data.items ||
      [];

    // --------------------------------------------
    // 라이브 없음
    // --------------------------------------------

    if (
      items.length === 0
    ) {

      console.log(
        "ℹ️ 현재 순대전사에서 진행 중인 라이브가 없습니다."
      );

      currentVideoId = null;
      currentLiveChatId = null;
      liveActive = false;

      return null;
    }

    // --------------------------------------------
    // Video ID
    // --------------------------------------------

    const videoId =
      items[0]?.id?.videoId;

    if (!videoId) {

      console.log(
        "⚠️ 라이브 Video ID를 찾지 못했습니다."
      );

      return null;
    }

    // --------------------------------------------
    // 이미 같은 방송이면
    // 추가 videos.list 불필요
    // --------------------------------------------

    if (
      currentVideoId === videoId &&
      currentLiveChatId
    ) {

      liveActive = true;

      return currentLiveChatId;
    }

    // --------------------------------------------
    // liveChatId 가져오기
    // --------------------------------------------

    const videoResponse =
      await youtube.videos.list({

        part:
          "liveStreamingDetails",

        id:
          videoId

      });

    const video =
      videoResponse.data.items?.[0];

    const liveChatId =
      video
        ?.liveStreamingDetails
        ?.activeLiveChatId;

    if (!liveChatId) {

      console.log(
        "ℹ️ 라이브 영상은 찾았지만 activeLiveChatId가 아직 없습니다."
      );

      currentVideoId = null;
      currentLiveChatId = null;
      liveActive = false;

      return null;
    }

    // --------------------------------------------
    // 새로운 방송
    // --------------------------------------------

    currentVideoId =
      videoId;

    currentLiveChatId =
      liveChatId;

    liveActive = true;

    console.log(
      "🎥 순대전사 새 방송 발견"
    );

    console.log(
      `🎬 Video ID: ${videoId}`
    );

    console.log(
      "💬 Live Chat ID 확인 완료"
    );

    console.log(
      "🚀 뉴스 자동 전송을 시작합니다."
    );

    return liveChatId;

  } catch (error) {

    console.error(
      "❌ 순대전사 라이브 검색 실패:"
    );

    console.error(
      error?.response?.data?.error?.message ||
      error.message
    );

    return null;
  }
}

// ======================================================
// 라이브 상태 초기화
// ======================================================

function resetLive() {

  console.log(
    "🔄 현재 라이브 정보를 초기화합니다."
  );

  currentVideoId = null;
  currentLiveChatId = null;
  liveActive = false;

  // 다음 뉴스 주기에서 즉시 라이브 검색 가능
  lastLiveSearchTime = 0;
}

// ======================================================
// YouTube 채팅 메시지 전송
// ======================================================

async function sendYouTubeChat(message) {

  if (!youtube) {

    console.error(
      "❌ YouTube API가 초기화되지 않았습니다."
    );

    return false;
  }

  // --------------------------------------------
  // liveChatId가 없으면 라이브 검색
  // --------------------------------------------

  if (!currentLiveChatId) {

    const liveChatId =
      await findCurrentLive();

    if (!liveChatId) {
      return false;
    }
  }

  try {

    await youtube.liveChatMessages.insert({

      part:
        "snippet",

      requestBody: {

        snippet: {

          liveChatId:
            currentLiveChatId,

          type:
            "textMessageEvent",

          textMessageDetails: {

            messageText:
              message

          }

        }

      }

    });

    console.log(
      `✅ 뉴스봇 채팅 전송 성공: ${message}`
    );

    return true;

  } catch (error) {

    const errorMessage =
      error?.response?.data?.error?.message ||
      error.message;

    console.error(
      "❌ YouTube 채팅 전송 실패:"
    );

    console.error(
      errorMessage
    );

    // --------------------------------------------
    // 방송 종료 감지
    // --------------------------------------------

    const lowerMessage =
      errorMessage.toLowerCase();

    const liveEnded =
      lowerMessage.includes(
        "live chat has ended"
      ) ||
      lowerMessage.includes(
        "live chat not found"
      ) ||
      lowerMessage.includes(
        "video is no longer live"
      ) ||
      lowerMessage.includes(
        "livechatid"
      );

    if (liveEnded) {

      console.log(
        "🛑 순대전사 라이브가 종료된 것으로 판단했습니다."
      );

      resetLive();
    }

    return false;
  }
}

// ======================================================
// 새로운 뉴스 선택
// ======================================================

function selectNewNews(
  newsList
) {

  for (
    const news of newsList
  ) {

    if (
      !sentNews.has(
        news.id
      )
    ) {

      return news;

    }
  }

  return null;
}

// ======================================================
// 뉴스 전송
// ======================================================

async function sendLatestNews() {

  console.log(
    `\n📰 ${new Date().toLocaleString(
      "ko-KR",
      {
        timeZone:
          "Asia/Seoul"
      }
    )} 뉴스 확인`
  );

  // --------------------------------------------
  // 라이브가 없는 경우
  // --------------------------------------------

  if (!currentLiveChatId) {

    const liveChatId =
      await findCurrentLive();

    if (!liveChatId) {

      console.log(
        "ℹ️ 라이브 방송이 없어 뉴스 전송을 건너뜁니다."
      );

      return;
    }
  }

  // --------------------------------------------
  // Google News 가져오기
  // --------------------------------------------

  const newsList =
    await fetchGoogleNews();

  if (
    newsList.length === 0
  ) {

    console.log(
      "⚠️ 가져온 뉴스가 없습니다."
    );

    return;
  }

  // --------------------------------------------
  // 새로운 뉴스 선택
  // --------------------------------------------

  const news =
    selectNewNews(
      newsList
    );

  if (!news) {

    console.log(
      "ℹ️ 새로운 뉴스가 없습니다."
    );

    return;
  }

  // --------------------------------------------
  // 메시지 작성
  // --------------------------------------------

  let message =
    `📰 ${news.title}`;

  if (news.source) {

    message +=
      ` [${news.source}]`;

  }

  // --------------------------------------------
  // 너무 긴 메시지 방지
  // --------------------------------------------

  if (
    message.length > 450
  ) {

    message =
      message.substring(
        0,
        447
      ) +
      "...";
  }

  // --------------------------------------------
  // YouTube 채팅 전송
  // --------------------------------------------

  const success =
    await sendYouTubeChat(
      message
    );

  // --------------------------------------------
  // 전송 성공한 경우만
  // 이미 보낸 뉴스로 기록
  // --------------------------------------------

  if (success) {

    sentNews.add(
      news.id
    );

    if (
      sentNews.size >
      MAX_SENT_NEWS
    ) {

      const first =
        sentNews
          .values()
          .next()
          .value;

      sentNews.delete(
        first
      );
    }
  }
}

// ======================================================
// 라이브 검색 타이머
// ======================================================

let liveTimer = null;

function startLiveChecker() {

  console.log(
    "🔎 순대전사 라이브 감시 시작"
  );

  console.log(
    "🔎 라이브가 없을 때만 15분마다 검색"
  );

  // 서버 시작 직후 검색
  lastLiveSearchTime = 0;

  findCurrentLive();

  // --------------------------------------------
  // 라이브가 없을 때만 실제 검색
  // --------------------------------------------

  liveTimer =
    setInterval(
      async () => {

        if (
          !currentLiveChatId
        ) {

          await findCurrentLive();

        }

      },
      NO_LIVE_CHECK_INTERVAL
    );
}

// ======================================================
// 뉴스 타이머
// ======================================================

let newsTimer = null;

function startNewsTimer() {

  console.log(
    "⏱️ Google News → 뉴스봇 → 순대전사"
  );

  console.log(
    "⏱️ 뉴스 전송 주기: 1분"
  );

  // 서버 시작 직후 확인
  sendLatestNews();

  // 이후 1분마다
  newsTimer =
    setInterval(
      sendLatestNews,
      NEWS_INTERVAL
    );
}

// ======================================================
// 서버 시작
// ======================================================

app.listen(
  PORT,
  () => {

    console.log(
      `\n🚀 Server running on port ${PORT}`
    );

    startLiveChecker();

    startNewsTimer();

  }
);
