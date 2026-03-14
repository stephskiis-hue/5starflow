Add-Type -AssemblyName System.Drawing

$srcPath = 'C:\Users\steph\Desktop\5starflow\.claude\screenshots\index-t2-desktop-10k.png'
$src = [System.Drawing.Bitmap]::new($srcPath)

Write-Host "Image size: $($src.Width) x $($src.Height)"

$crops = @(
  @{name="full-bottom-half"; y=5000; h=5000},
  @{name="bottom-quarter"; y=7500; h=2500}
)

foreach ($c in $crops) {
  $h = [Math]::Min($c.h, $src.Height - $c.y)
  if ($h -le 0) { Write-Host "Skipping $($c.name) - out of bounds"; continue }
  $rect = [System.Drawing.Rectangle]::new(0, $c.y, $src.Width, $h)
  $bmp = $src.Clone($rect, $src.PixelFormat)
  $outPath = "C:\Users\steph\Desktop\5starflow\.claude\screenshots\crop10k-$($c.name).png"
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "Saved: $outPath"
}
$src.Dispose()
Write-Host "Done"
