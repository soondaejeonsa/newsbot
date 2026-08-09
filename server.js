import express from "express";
import fetch from "node-fetch";
import xml2js from "xml2js";
import { google } from "googleapis";

const app = express();

const PORT = process.env.PORT || 8080;

// ======================================================
// 설정
// ======================================================

// 쩡햄Live 채널
const TARGET_CHANNEL_ID = "UChqJ-rp_I9NKwZOtzI11jNw";

// Google News RSS
const GOOGLE_NEWS_RSS =
  "https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko";

// 뉴스 전송 주기: 1분
const NEWS_INTERVAL = 60 * 1000;

// 라이브 방송 검색 주기: 5분
// 매 1분마다 search.list를 호출하면 API 할당량을 불필요하게 많이 사용함
const LIVE_CHECK_INTERVAL = 5 * 60 * 1000;

// 한 번에 보낼 뉴스 개수
const NEWS_PER_MESSAGE = 1;

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
    throw new Error("YOUTUBE_CLIENT_ID가 없습니다.");
  }

  if (!process.env.YOUTUBE_CLIENT_SECRET) {
    throw new Error("YOUTUBE_CLIENT_SECRET이 없습니다.");
  }

  if (!process.env.YOUTUBE_REFRESH_TOKEN) {
    throw new Error("YOUTUBE_REFRESH_TOKEN이 없습니다.");
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    "http://localhost"
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.YOUTUBE_REFRESH_TOKEN
  });

  youtube = google.youtube({
    version: "v3",
    auth: oauth2Client
  });

  console.log("✅ YouTube API 인증 설정 완료");

} catch (error) {

  console.error("❌ YouTube 인증 설정 실패:");
  console.error(error.message);

}

// ======================================================
// RSS Parser
// ======================================================

const parser = new xml2js.Parser({
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

// 라이브가 없다는 로그가 매번 반복되지 않도록
let lastNoLiveLogTime = 0;

// ======================================================
// Google News 가져오기
// ======================================================

async function fetchGoogleNews() {

  try {

    const response = await fetch(GOOGLE_NEWS_RSS, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      throw new Error(
        `Google News RSS 오류: ${response.status}`
      );
    }

    const xml = await response.text();

    const result =
      await parser.parseStringPromise(xml);

    let items =
      result?.rss?.channel?.item || [];

    if (!Array.isArray(items)) {
      items = [items];
    }

    const news = items
      .filter(item => item && item.title)
      .map(item => {

        let title = item.title;

        let link = "";

        if (typeof item.link === "string") {
          link = item.link;
        } else if (item.link?._) {
          link = item.link._;
        }

        let source = "";

        if (title.includes(" - ")) {

          const parts = title.split(" - ");

          source =
            parts.pop().trim();

          title =
            parts.join(" - ").trim();
        }

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
// 쩡햄Live의 현재 라이브 찾기
// ======================================================

async function findCurrentLive() {

  if (!youtube) {
    throw new Error(
      "YouTube API가 초기화되지 않았습니다."
    );
  }

  try {

    // --------------------------------------------------
    // 1. 쩡햄Live 채널에서 현재 LIVE 영상 검색
    // --------------------------------------------------

    const searchResponse =
      await youtube.search.list({

        part: "id,snippet",

        channelId: TARGET_CHANNEL_ID,

        eventType: "live",

        type: "video",

        maxResults: 1

      });

    const items =
      searchResponse.data.items || [];

    if (items.length === 0) {

      // 5분에 한 번 정도만 로그
      const now = Date.now();

      if (
        now - lastNoLiveLogTime >
        LIVE_CHECK_INTERVAL
      ) {

        console.log(
          "ℹ️ 현재 쩡햄Live에서 진행 중인 라이브가 없습니다."
        );

        lastNoLiveLogTime = now;
      }

      currentVideoId = null;
      currentLiveChatId = null;

      return null;
    }

    const videoId =
      items[0]?.id?.videoId;

    if (!videoId) {
      return null;
    }

    // --------------------------------------------------
    // 2. 영상의 liveChatId 가져오기
    // --------------------------------------------------

    const videoResponse =
      await youtube.videos.list({

        part: "liveStreamingDetails",

        id: videoId

      });

    const video =
      videoResponse.data.items?.[0];

    const liveChatId =
      video?.liveStreamingDetails?.activeLiveChatId;

    if (!liveChatId) {

      console.log(
        "ℹ️ 라이브 영상은 찾았지만 아직 activeLiveChatId가 없습니다."
      );

      currentVideoId = null;
      currentLiveChatId = null;

      return null;
    }

    // --------------------------------------------------
    // 3. 새로운 방송인지 확인
    // --------------------------------------------------

    if (currentVideoId !== videoId) {

      console.log(
        `🎥 쩡햄Live 새 방송 발견`
      );

      console.log(
        `🎬 Video ID: ${videoId}`
      );

      console.log(
        `💬 Live Chat ID 확인 완료`
      );

      currentVideoId = videoId;
      currentLiveChatId = liveChatId;

    } else {

      currentLiveChatId = liveChatId;
    }

    return currentLiveChatId;

  } catch (error) {

    console.error(
      "❌ 쩡햄Live 라이브 검색 실패:"
    );

    console.error(
      error?.response?.data?.error?.message ||
      error.message
    );

    return null;
  }
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

  // 현재 liveChatId가 없으면 라이브 확인
  if (!currentLiveChatId) {

    const liveChatId =
      await findCurrentLive();

    if (!liveChatId) {
      return false;
    }
  }

  try {

    await youtube.liveChatMessages.insert({

      part: "snippet",

      requestBody: {

        snippet: {

          liveChatId: currentLiveChatId,

          type: "textMessageEvent",

          textMessageDetails: {

            messageText: message

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

    console.error(errorMessage);

    // --------------------------------------------------
    // 방송이 끝났거나 liveChatId가 무효화된 경우
    // 다음 전송 때 다시 라이브를 찾도록 초기화
    // --------------------------------------------------

    const errorDetails =
      error?.response?.data?.error?.errors || [];

    const isLiveEnded =
      errorMessage
        ?.toLowerCase()
        .includes("live chat has ended") ||
      errorMessage
        ?.toLowerCase()
        .includes("live chat not found");

    if (isLiveEnded) {

      console.log(
        "🔄 현재 라이브가 종료된 것으로 판단하여 라이브 정보를 초기화합니다."
      );

      currentVideoId = null;
      currentLiveChatId = null;
    }

    return false;
  }
}

// ======================================================
// 새로운 뉴스 선택
// ======================================================

function selectNewNews(newsList) {

  for (const news of newsList) {

    if (!sentNews.has(news.id)) {

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
        timeZone: "Asia/Seoul"
      }
    )} 뉴스 확인`
  );

  // --------------------------------------------------
  // 라이브가 없으면 뉴스도 가져오지 않음
  // --------------------------------------------------

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

  // --------------------------------------------------
  // Google News 가져오기
  // --------------------------------------------------

  const newsList =
    await fetchGoogleNews();

  if (newsList.length === 0) {

    console.log(
      "⚠️ 가져온 뉴스가 없습니다."
    );

    return;
  }

  // --------------------------------------------------
  // 새로운 뉴스 선택
  // --------------------------------------------------

  const news =
    selectNewNews(newsList);

  if (!news) {

    console.log(
      "ℹ️ 새로운 뉴스가 없습니다."
    );

    return;
  }

  // --------------------------------------------------
  // 채팅 메시지
  // --------------------------------------------------

  let message =
    `📰 ${news.title}`;

  if (news.source) {

    message +=
      ` [${news.source}]`;

  }

  // YouTube 메시지 길이 제한 대비
  if (message.length > 450) {

    message =
      message.substring(0, 447) +
      "...";
  }

  // --------------------------------------------------
  // 전송
  // --------------------------------------------------

  const success =
    await sendYouTubeChat(message);

  if (success) {

    sentNews.add(news.id);

    // 메모리 정리
    if (
      sentNews.size >
      MAX_SENT_NEWS
    ) {

      const first =
        sentNews.values().next().value;

      sentNews.delete(first);
    }

  }

}

// ======================================================
// 라이브 검색 타이머
// ======================================================

let liveTimer = null;

function startLiveChecker() {

  console.log(
    "🔎 쩡햄Live 라이브 자동 검색 시작"
  );

  console.log(
    "🔎 라이브 확인 주기: 5분"
  );

  // 서버 시작 직후 확인
  findCurrentLive();

  // 이후 5분마다 확인
  liveTimer =
    setInterval(
      findCurrentLive,
      LIVE_CHECK_INTERVAL
    );
}

// ======================================================
// 뉴스 타이머
// ======================================================

let newsTimer = null;

function startNewsTimer() {

  console.log(
    "⏱️ Google News → 뉴스봇 → 쩡햄Live"
  );

  console.log(
    "⏱️ 뉴스 전송 주기: 1분"
  );

  // 서버 시작 직후 한 번 확인
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

app.listen(PORT, () => {

  console.log(
    `\n🚀 Server running on port ${PORT}`
  );

  startLiveChecker();

  startNewsTimer();

});
