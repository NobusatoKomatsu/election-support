package support.election.admin

import android.app.AlertDialog
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * みんなの声（election.support）の管理アプリ。
 * 管理者トークンで、投票テーマの一覧・作成・編集・削除を行う。
 * 画面はすべてコードで組み立てる（一覧 → 編集の 2 画面と、最初のトークン入力）。
 */
class MainActivity : ComponentActivity() {

    companion object {
        const val DEFAULT_SERVER = "https://election.support"
        const val PREFS = "admin"
    }

    private enum class Screen { TOKEN, LIST, EDIT }

    private class ApiError(message: String) : Exception(message)

    private data class Option(val id: Long?, var label: String, val voters: Int)

    private data class Poll(
        val id: Long,
        val title: String,
        val description: String,
        val opensAt: Long,
        val closesAt: Long,
        val status: String,
        val voters: Int,
        val options: List<Option>,
    )

    private lateinit var root: FrameLayout
    private var screen = Screen.TOKEN
    private val zone: ZoneId get() = ZoneId.systemDefault()
    private val dateFmt = DateTimeFormatter.ofPattern("M/d(E) HH:mm")

    private val prefs by lazy { getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    private var token: String
        get() = prefs.getString("token", "") ?: ""
        set(v) = prefs.edit().putString("token", v).apply()
    private var server: String
        get() = prefs.getString("server", DEFAULT_SERVER) ?: DEFAULT_SERVER
        set(v) = prefs.edit().putString("server", v.trimEnd('/')).apply()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        root = FrameLayout(this).apply { setBackgroundColor(color(R.color.bg)) }
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (screen == Screen.EDIT) showList() else finish()
            }
        })
        if (token.isEmpty()) showToken() else showList()
    }

    // ---------------- API ----------------

    private suspend fun api(method: String, path: String, body: JSONObject? = null): JSONObject =
        withContext(Dispatchers.IO) {
            val conn = (URL(server + path).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 15000
                readTimeout = 20000
                setRequestProperty("authorization", "Bearer $token")
                setRequestProperty("accept", "application/json")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("content-type", "application/json; charset=utf-8")
                }
            }
            try {
                if (body != null) conn.outputStream.use { it.write(body.toString().toByteArray()) }
                val code = conn.responseCode
                val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.use { it.readText() } ?: ""
                val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
                if (code !in 200..299) throw ApiError(json.optString("error").ifEmpty { "エラーが起きました（$code）" })
                json
            } catch (e: IOException) {
                throw ApiError("サーバーにつながりません。電波の状態を確かめてください")
            } finally {
                conn.disconnect()
            }
        }

    private fun parsePolls(json: JSONObject): List<Poll> {
        val arr = json.optJSONArray("polls") ?: JSONArray()
        return (0 until arr.length()).map { i ->
            val p = arr.getJSONObject(i)
            val opts = p.optJSONArray("options") ?: JSONArray()
            Poll(
                id = p.getLong("id"),
                title = p.optString("title"),
                description = p.optString("description"),
                opensAt = p.getLong("opens_at"),
                closesAt = p.getLong("closes_at"),
                status = p.optString("status"),
                voters = p.optInt("voters"),
                options = (0 until opts.length()).map { j ->
                    val o = opts.getJSONObject(j)
                    Option(o.getLong("id"), o.optString("label"), o.optInt("voters"))
                },
            )
        }
    }

    // ---------------- 画面: トークン入力 ----------------

    private fun showToken(error: String? = null) {
        screen = Screen.TOKEN
        val page = page()
        page.addView(title("みんなの声 管理"))
        page.addView(muted("サイトの管理者トークン（GitHub の Secrets に VOTE_ADMIN_TOKEN として登録したもの）を入力してください。この端末の中にだけ保存されます。"))
        val tokenInput = input("管理者トークン", token, password = true)
        page.addView(label("管理者トークン")); page.addView(tokenInput)
        val serverInput = input("サーバー", server)
        serverInput.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        page.addView(label("サーバー（通常は変更不要）")); page.addView(serverInput)
        val msg = message(error)
        page.addView(msg)
        page.addView(primary("保存して開く") {
            val t = tokenInput.text.toString().trim()
            if (t.isEmpty()) { showMessage(msg, "管理者トークンを入力してください"); return@primary }
            token = t
            server = serverInput.text.toString().trim().ifEmpty { DEFAULT_SERVER }
            showList()
        })
    }

    // ---------------- 画面: 一覧 ----------------

    private fun showList(note: String? = null) {
        screen = Screen.LIST
        val page = page()
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(title("テーマ一覧"), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(primary("＋ 新規", small = true) { showEdit(null) })
        page.addView(header)
        if (note != null) page.addView(message(note, ok = true))
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        page.addView(list)
        list.addView(ProgressBar(this).apply { setPadding(0, dp(24), 0, dp(24)) })
        val footer = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(16), 0, 0) }
        footer.addView(ghost("再読み込み") { showList() })
        footer.addView(space(), LinearLayout.LayoutParams(0, 1, 1f))
        footer.addView(ghost("トークン変更") { showToken() })
        page.addView(footer)

        lifecycleScope.launch {
            try {
                val polls = parsePolls(api("GET", "/api/admin/polls"))
                list.removeAllViews()
                if (polls.isEmpty()) list.addView(card().apply { addView(muted("まだテーマがありません。「＋ 新規」から作れます。")) })
                polls.forEach { p -> list.addView(pollCard(p)) }
            } catch (e: ApiError) {
                if (e.message?.contains("管理者トークン") == true) showToken(e.message)
                else { list.removeAllViews(); list.addView(message(e.message)) }
            }
        }
    }

    private fun pollCard(p: Poll): View = card().apply {
        isClickable = true
        isFocusable = true
        setOnClickListener { showEdit(p) }
        val top = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        top.addView(TextView(context).apply {
            text = p.title
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(color(R.color.fg))
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        top.addView(badge(p.status))
        addView(top)
        addView(muted("#${p.id}　${fmt(p.opensAt)} 〜 ${fmt(p.closesAt)}\n投票 ${p.voters} 人・選択肢 ${p.options.size} 個"))
        addView(ghost("SNS でシェア") { share(p) })
    }

    // ---------------- SNS でシェア ----------------
    // Android の共有画面を出し、X・LINE・Facebook など、端末でログインしているアプリを選んで投稿する。
    // リンクは /p/<番号>。SNS にはテーマのタイトルとアイコンのカードが出て、開くとテーマのページへ移る。

    private fun shareText(p: Poll): String {
        val url = "$server/p/${p.id}"
        return when (p.status) {
            "open" -> "【投票受付中】${p.title}\n" +
                "${fmt(p.closesAt)} まで受付中。年代・性別・年収・年金の受給状況ごとの民意を、リアルタイムで公開しています。\n" +
                "あなたの 1 票を聞かせてください👇\n$url\n#みんなの声"
            "upcoming" -> "【${fmt(p.opensAt)} から受付開始】${p.title}\n" +
                "年代・性別・年収・年金の受給状況ごとの民意を、リアルタイムで公開します。\n$url\n#みんなの声"
            else -> "【投票結果】${p.title}\n" +
                "${p.voters} 人が投票しました。年代・年収などの属性ごとの結果はこちら👇\n$url\n#みんなの声"
        }
    }

    private fun share(p: Poll) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, p.title)
            putExtra(Intent.EXTRA_TEXT, shareText(p))
        }
        startActivity(Intent.createChooser(send, "シェアする SNS を選ぶ"))
    }

    // ---------------- 画面: 作成・編集 ----------------

    private fun showEdit(poll: Poll?) {
        screen = Screen.EDIT
        val page = page()
        page.addView(ghost("← テーマ一覧") { showList() })
        page.addView(title(if (poll == null) "新しいテーマ" else "テーマを編集"))
        val locked = poll != null && poll.voters > 0

        val titleInput = input("例：消費税を引き下げるべきか", poll?.title ?: "")
        page.addView(label("タイトル")); page.addView(titleInput)
        val descInput = input("説明（任意）", poll?.description ?: "", multiline = true)
        page.addView(label("説明")); page.addView(descInput)

        page.addView(label("選択肢（2〜20 個）"))
        val optBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        page.addView(optBox)
        val rows = mutableListOf<Pair<Option, EditText>>()
        fun addRow(o: Option) {
            val row = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(0, 0, 0, dp(6)) }
            val et = input("選択肢", o.label)
            row.addView(et, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            val pair = o to et
            rows.add(pair)
            if (o.voters > 0) {
                row.addView(muted("  ${o.voters} 人"))
            } else {
                row.addView(ghost("×") { rows.remove(pair); optBox.removeView(row) })
            }
            optBox.addView(row)
        }
        (poll?.options ?: listOf(Option(null, "賛成", 0), Option(null, "反対", 0))).forEach { addRow(it.copy()) }
        page.addView(ghost("＋ 選択肢を追加") { addRow(Option(null, "", 0)) })

        val now = System.currentTimeMillis()
        var opensAt = poll?.opensAt ?: now
        var closesAt = poll?.closesAt ?: (now + 7L * 86_400_000)
        page.addView(label("受付開始" + if (locked) "（投票が入っているため変更できません）" else ""))
        val opensBtn = ghost(fmt(opensAt)) {}
        opensBtn.isEnabled = !locked
        opensBtn.setOnClickListener { pickDateTime(opensAt) { opensAt = it; opensBtn.text = fmt(it) } }
        page.addView(opensBtn)
        page.addView(label("受付終了"))
        val closesBtn = ghost(fmt(closesAt)) {}
        closesBtn.setOnClickListener { pickDateTime(closesAt) { closesAt = it; closesBtn.text = fmt(it) } }
        page.addView(closesBtn)

        val msg = message(null)
        page.addView(msg)
        val save = primary(if (poll == null) "作成" else "保存") {}
        save.setOnClickListener {
            val options = JSONArray()
            rows.forEach { (o, et) ->
                options.put(JSONObject().apply {
                    if (o.id != null) put("id", o.id)
                    put("label", et.text.toString().trim())
                })
            }
            val body = JSONObject().apply {
                put("title", titleInput.text.toString().trim())
                put("description", descInput.text.toString().trim())
                put("options", options)
                put("opens_at", opensAt)
                put("closes_at", closesAt)
            }
            save.isEnabled = false
            lifecycleScope.launch {
                try {
                    if (poll == null) api("POST", "/api/admin/polls", body)
                    else api("PUT", "/api/admin/polls/${poll.id}", body)
                    showList(if (poll == null) "テーマを作りました" else "保存しました")
                } catch (e: ApiError) {
                    showMessage(msg, e.message)
                    save.isEnabled = true
                }
            }
        }
        page.addView(save)

        if (poll != null) {
            page.addView(primary("SNS でシェア") { share(poll) })
            page.addView(ghost("結果をブラウザで開く") {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("$server/#/poll/${poll.id}")))
            })
            page.addView(danger("このテーマを削除") {
                val warn = if (poll.voters > 0) "${poll.voters} 人の投票も一緒に消え、元に戻せません。" else "元に戻せません。"
                AlertDialog.Builder(this)
                    .setTitle("「${poll.title}」を削除しますか？")
                    .setMessage(warn)
                    .setNegativeButton("やめる", null)
                    .setPositiveButton("削除する") { _, _ ->
                        lifecycleScope.launch {
                            try {
                                api("DELETE", "/api/admin/polls/${poll.id}")
                                showList("「${poll.title}」を削除しました")
                            } catch (e: ApiError) {
                                showMessage(msg, e.message)
                            }
                        }
                    }
                    .show()
            })
        }
    }

    private fun pickDateTime(initial: Long, onPicked: (Long) -> Unit) {
        val dt = LocalDateTime.ofInstant(Instant.ofEpochMilli(initial), zone)
        DatePickerDialog(this, { _, y, m, d ->
            TimePickerDialog(this, { _, h, min ->
                onPicked(LocalDateTime.of(y, m + 1, d, h, min).atZone(zone).toInstant().toEpochMilli())
            }, dt.hour, dt.minute, true).show()
        }, dt.year, dt.monthValue - 1, dt.dayOfMonth).show()
    }

    private fun fmt(ms: Long): String = LocalDateTime.ofInstant(Instant.ofEpochMilli(ms), zone).format(dateFmt)

    // ---------------- 部品 ----------------

    private fun color(id: Int) = ContextCompat.getColor(this, id)
    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
    private fun rounded(fill: Int, stroke: Int? = null, radius: Int = 12) = GradientDrawable().apply {
        cornerRadius = dp(radius).toFloat()
        setColor(fill)
        if (stroke != null) setStroke(dp(1), stroke)
    }

    private fun page(): LinearLayout {
        root.removeAllViews()
        val scroll = ScrollView(this).apply { isFillViewport = true }
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(32))
        }
        scroll.addView(col)
        root.addView(scroll)
        ViewCompat.requestApplyInsets(root)
        return col
    }

    private fun space() = View(this)

    private fun title(text: String) = TextView(this).apply {
        this.text = text
        textSize = 22f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(color(R.color.fg))
        setPadding(0, dp(4), 0, dp(12))
    }

    private fun label(text: String) = TextView(this).apply {
        this.text = text
        textSize = 14f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(color(R.color.fg))
        setPadding(0, dp(14), 0, dp(6))
    }

    private fun muted(text: String) = TextView(this).apply {
        this.text = text
        textSize = 13f
        setTextColor(color(R.color.muted))
        setPadding(0, dp(4), 0, 0)
    }

    private fun input(hint: String, value: String, password: Boolean = false, multiline: Boolean = false) = EditText(this).apply {
        this.hint = hint
        setText(value)
        textSize = 16f
        setTextColor(color(R.color.fg))
        setHintTextColor(color(R.color.muted))
        background = rounded(color(R.color.surface), color(R.color.line), 8)
        setPadding(dp(12), dp(10), dp(12), dp(10))
        inputType = when {
            password -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            multiline -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            else -> InputType.TYPE_CLASS_TEXT
        }
        if (multiline) { minLines = 3; gravity = Gravity.TOP or Gravity.START }
    }

    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(color(R.color.surface), color(R.color.line))
        setPadding(dp(16), dp(14), dp(16), dp(14))
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            .apply { bottomMargin = dp(10) }
    }

    private fun badge(status: String) = TextView(this).apply {
        text = when (status) { "open" -> "受付中"; "upcoming" -> "開始前"; else -> "終了" }
        textSize = 12f
        setPadding(dp(8), dp(2), dp(8), dp(2))
        if (status == "open") {
            setTextColor(color(R.color.ok_text)); background = rounded(color(R.color.ok_bg), radius = 6)
        } else {
            setTextColor(color(R.color.muted)); background = rounded(color(R.color.surface), color(R.color.line), 6)
        }
    }

    private fun message(text: String?, ok: Boolean = false) = TextView(this).apply {
        textSize = 14f
        setPadding(dp(12), dp(10), dp(12), dp(10))
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            .apply { topMargin = dp(10); bottomMargin = dp(4) }
        tag = ok
        showMessage(this, text)
    }

    private fun showMessage(view: TextView, text: String?) {
        val ok = view.tag == true
        view.text = text ?: ""
        view.visibility = if (text.isNullOrEmpty()) View.GONE else View.VISIBLE
        view.setTextColor(color(if (ok) R.color.ok_text else R.color.err_text))
        view.background = rounded(color(if (ok) R.color.ok_bg else R.color.err_bg), radius = 8)
    }

    private fun button(text: String, fg: Int, bg: GradientDrawable, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        isAllCaps = false
        textSize = 15f
        setTextColor(fg)
        background = bg
        stateListAnimator = null
        setPadding(dp(16), dp(8), dp(16), dp(8))
        minHeight = dp(44)
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            .apply { topMargin = dp(8) }
    }

    private fun primary(text: String, small: Boolean = false, onClick: () -> Unit) =
        button(text, color(R.color.accent_text), rounded(color(R.color.accent), radius = 8), onClick).apply {
            if (!small) layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = dp(16) }
        }

    private fun ghost(text: String, onClick: () -> Unit) =
        button(text, color(R.color.accent), rounded(color(R.color.surface), color(R.color.line), 8), onClick)

    private fun danger(text: String, onClick: () -> Unit) =
        button(text, color(R.color.err_text), rounded(color(R.color.surface), color(R.color.line), 8), onClick).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = dp(28) }
        }
}
