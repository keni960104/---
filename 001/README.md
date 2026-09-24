# 001 - 做一個 MQTT 應用聯機遊戲

用 MQTT 做一個「單人就能玩」的貪吃蛇 (Snake)。遊戲拆成兩個獨立的程式，中間完全用
MQTT 溝通：一個是遊戲畫面本體，一個是控制端，兩個視窗都由同一個人操作，但移動指令
一定要透過 MQTT broker 傳遞，藉此示範 MQTT 的 publish/subscribe 架構怎麼拿來做
即時控制。

## 檔案說明

| 檔案 | 說明 |
|---|---|
| `mosquitto.conf` | 本機 Mosquitto broker 的設定檔，開放 1883 port、允許匿名連線 |
| `requirements.txt` | Python 套件需求 (`paho-mqtt`、`pygame`) |
| `common.py` | 共用的 MQTT topic 名稱設定 |
| `display.py` | 遊戲畫面本體，跑貪吃蛇邏輯，只聽 MQTT 指令來轉向 (自己視窗按方向鍵沒作用) |
| `controller.py` | 控制端小視窗，讀方向鍵/WASD 發布 MQTT 指令，並顯示即時分數 |

## 架構說明 (寫報告可以用)

`display.py` 和 `controller.py` 是兩個完全獨立的程式，都連到同一台 Mosquitto
broker，用底下這些 topic 溝通：

- `snake/control`：controller 發布方向指令，例如 `{"direction": "up"}`，或重新開始
  指令 `{"command": "restart"}`；display 訂閱這個 topic 來轉向蛇的移動方向
- `snake/score`：display 每次吃到食物分數增加時，publish `{"score": int}` (retain=True，
  controller 晚一點連上也能馬上看到目前分數)
- `snake/gameover`：display 判定撞牆/撞到自己時，publish `{"score": int}` 通知遊戲結束

`display.py` 是唯一擁有遊戲邏輯的地方 (移動、吃東西、撞牆判定)，`controller.py`
完全不知道棋盤/蛇身長什麼樣子，只單純送出方向指令、顯示分數——這樣可以清楚示範
MQTT 讓「輸入裝置」和「遊戲畫面」兩個完全分開的程式，還是能即時互動。

## 安裝

1. 安裝 Python 3.9 以上、安裝 Mosquitto (你說你已經會裝了)
2. 在這個資料夾底下安裝套件:

   ```powershell
   pip install -r requirements.txt
   ```

## 啟動步驟

### 1. 啟動 MQTT broker

在這個資料夾底下執行 (用專案附的設定檔，開放區網連線):

```powershell
mosquitto -c mosquitto.conf -v
```

看到類似 `Opening ipv4 listen socket on port 1883.` 就代表啟動成功，這個視窗要一直
開著。

### 2. 啟動遊戲畫面

開一個新的終端機:

```powershell
python display.py
```

會跳出一個貪吃蛇的遊戲視窗，但這時候按方向鍵是沒有用的 (故意設計成這樣)。

### 3. 啟動控制端

再開一個終端機:

```powershell
python controller.py
```

會跳出一個小視窗，把這個小視窗點成「作用中」(在最上層)，按方向鍵/WASD 就能控制
剛剛那個遊戲畫面裡的蛇移動。遊戲結束後，在這個控制端視窗按 `R` 可以重新開始。

### 4. 想把控制端放到另一台電腦/手機上

1. 確認兩台裝置在同一個區網 (同一個 Wi-Fi/路由器)
2. 在跑 broker 的那台電腦上，用 `ipconfig` 查詢區網 IP (IPv4 位址，例如 `192.168.1.5`)
3. Windows 防火牆要允許 1883 port 的連入連線 (第一次執行 mosquitto 通常會跳出防火牆
   詢問視窗，允許即可)
4. `display.py` 和 `controller.py` 都可以帶入該 IP:

   ```powershell
   python controller.py 192.168.1.5
   ```

## 之後可以擴充的方向

- 幫 controller.py 加上難度選擇 (發布 `{"command": "speed", "value": ...}` 讓 display
  調整 `FPS`)
- 把 `snake/score` 的最高分記錄下來，用 retain 訊息做一個簡易排行榜
- 用手機瀏覽器做一個網頁版 controller (透過 MQTT over WebSocket) 取代 pygame 控制端
