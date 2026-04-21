package eu.kanade.tachiyomi.extension.all.mangalibrary

import android.content.SharedPreferences
import android.text.InputType
import androidx.preference.EditTextPreference
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.source.ConfigurableSource
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.HttpSource
import keiyoushi.utils.getPreferencesLazy
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class MangaLibrary :
    HttpSource(),
    ConfigurableSource {
    override val name = "Manga Library"
    override val lang = "all"
    override val supportsLatest = true

    private val preferences: SharedPreferences by getPreferencesLazy()

    override val baseUrl: String
        get() {
            val raw = preferences.getString(PREF_SERVER_URL, DEFAULT_SERVER_URL).orEmpty().trim().trimEnd('/')
            val url = raw.ifBlank { DEFAULT_SERVER_URL }.trimEnd('/')
            return if (url.endsWith("/mihon")) url else "$url/mihon"
        }

    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        EditTextPreference(screen.context).apply {
            key = PREF_SERVER_URL
            title = "Manga Library server URL"
            summary = preferences.getString(PREF_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
            dialogTitle = "Manga Library server URL"
            dialogMessage = "Enter the mobile Mihon URL shown in the desktop app. Example: http://192.168.0.10:17099/mihon"
            setDefaultValue(DEFAULT_SERVER_URL)
            setOnBindEditTextListener {
                it.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            }
            setOnPreferenceChangeListener { preference, newValue ->
                val value = (newValue as String).trim().trimEnd('/')
                val normalized = if (value.endsWith("/mihon")) value else "$value/mihon"
                if (normalized.toHttpUrlOrNull() == null) return@setOnPreferenceChangeListener false
                preference.summary = normalized
                true
            }
        }.also(screen::addPreference)
    }

    override fun popularMangaRequest(page: Int): Request = GET("$baseUrl/catalog?page=${page - 1}&size=$PAGE_SIZE", headers)

    override fun popularMangaParse(response: Response): MangasPage = parseMangaList(response)

    override fun latestUpdatesRequest(page: Int): Request = GET("$baseUrl/latest?page=${page - 1}&size=$PAGE_SIZE", headers)

    override fun latestUpdatesParse(response: Response): MangasPage = parseMangaList(response)

    override fun searchMangaRequest(page: Int, query: String, filters: FilterList): Request {
        val q = URLEncoder.encode(query, StandardCharsets.UTF_8.name())
        return GET("$baseUrl/search?page=${page - 1}&size=$PAGE_SIZE&q=$q", headers)
    }

    override fun searchMangaParse(response: Response): MangasPage = parseMangaList(response)

    override fun mangaDetailsRequest(manga: SManga): Request = GET(absUrl(manga.url), headers)

    override fun mangaDetailsParse(response: Response): SManga {
        val item = JSONObject(response.body.string())
        return mangaFromJson(item).apply {
            description = item.optString("description")
            status = SManga.COMPLETED
        }
    }

    override fun chapterListRequest(manga: SManga): Request {
        val path = if (manga.url.startsWith("/artist/")) {
            "${absUrl(manga.url)}/works"
        } else {
            "${absUrl(manga.url)}/pages"
        }
        return GET(path, headers)
    }

    override fun chapterListParse(response: Response): List<SChapter> {
        val json = JSONObject(response.body.string())
        if (json.has("chapters")) {
            val chapters = json.getJSONArray("chapters")
            return List(chapters.length()) { i ->
                val chapter = chapters.getJSONObject(i)
                SChapter.create().apply {
                    name = chapter.optString("name", "Read")
                    url = chapter.getString("url")
                    chapter_number = chapter.optDouble("chapterNumber", i + 1.0).toFloat()
                }
            }.reversed()
        }

        val workId = json.optString("workId")
        return listOf(
            SChapter.create().apply {
                name = "Read"
                url = "/work/$workId/pages"
                chapter_number = 1f
            },
        )
    }

    override fun pageListRequest(chapter: SChapter): Request = GET(absUrl(chapter.url), headers)

    override fun pageListParse(response: Response): List<Page> {
        val json = JSONObject(response.body.string())
        val pages = json.getJSONArray("pages")
        return List(pages.length()) { i ->
            val page = pages.getJSONObject(i)
            Page(
                index = page.optInt("index", i),
                url = "",
                imageUrl = page.getString("imageUrl"),
            )
        }
    }

    override fun imageUrlParse(response: Response): String = response.request.url.toString()

    private fun parseMangaList(response: Response): MangasPage {
        val json = JSONObject(response.body.string())
        val items = json.getJSONArray("items")
        val mangas = List(items.length()) { i -> mangaFromJson(items.getJSONObject(i)) }
        return MangasPage(mangas, json.optBoolean("hasNextPage", false))
    }

    private fun mangaFromJson(item: JSONObject): SManga {
        val id = item.getString("id")
        return SManga.create().apply {
            title = item.optString("title", "Untitled")
            artist = item.optString("artist")
            author = item.optString("author")
            thumbnail_url = item.optString("thumbnailUrl")
            url = item.optString("url", "/work/$id")
            status = SManga.COMPLETED
            initialized = true
        }
    }

    private fun absUrl(url: String): String = if (url.startsWith("http")) url else "$baseUrl$url"

    companion object {
        private const val PAGE_SIZE = 50
        private const val PREF_SERVER_URL = "server_url"
        private const val DEFAULT_SERVER_URL = "http://127.0.0.1:17099/mihon"
    }
}
