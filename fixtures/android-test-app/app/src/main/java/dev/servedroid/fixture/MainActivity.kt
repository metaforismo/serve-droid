package dev.servedroid.fixture

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.TextView

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        renderIntent(intent)

        findViewById<Button>(R.id.submit_button).setOnClickListener {
            val name = findViewById<EditText>(R.id.name_input).text.toString().ifBlank { "anonymous" }
            findViewById<TextView>(R.id.result).text = "Submitted for $name"
            Log.i("ServeDroidFixture", "Submitted fixture form for $name")
        }
        findViewById<Button>(R.id.dialog_button).setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle("Fixture dialog")
                .setMessage("This dialog is deterministic.")
                .setPositiveButton("Confirm") { _, _ -> Log.i("ServeDroidFixture", "Dialog confirmed") }
                .setNegativeButton("Cancel", null)
                .show()
        }
        findViewById<Button>(R.id.permission_button).setOnClickListener {
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(Manifest.permission.CAMERA), 100)
            }
        }
        findViewById<Button>(R.id.file_button).setOnClickListener {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
            }, 200)
        }
        findViewById<Button>(R.id.crash_button).setOnClickListener {
            Log.e("ServeDroidFixture", "Intentional fixture crash requested")
            error("Intentional serve-droid fixture crash")
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        renderIntent(intent)
    }

    private fun renderIntent(intent: Intent) {
        findViewById<TextView>(R.id.deep_link_state).text = intent.data?.toString() ?: "No deep link"
        Log.i("ServeDroidFixture", "Activity opened with ${intent.data ?: "launcher"}")
    }
}
