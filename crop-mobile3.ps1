Add-Type -AssemblyName System.Drawing

$srcPath = 'C:\Users\steph\Desktop\5starflow\.claude\screenshots\index-t2-mobile-full3.png'
$src = [System.Drawing.Bitmap]::new($srcPath)

Write-Host "Image size: $($src.Width) x $($src.Height)"

$crops = @(
  @{name="m3-how-it-works"; y=2000; h=1200},
  @{name="m3-features"; y=3200; h=1200},
  @{name="m3-testimonials"; y=4400; h=1200},
  @{name="m3-pricing"; y=5500; h=500}
)

foreach ($c in $crops) {
  $h = [Math]::Min($c.h, $src.Height - $c.y)
  if ($h -le 0) { Write-Host "Skipping $($c.name) - out of bounds"; continue }
  $rect = [System.Drawing.Rectangle]::new(0, $c.y, $src.Width, $h)
  $bmp = $src.Clone($rect, $src.PixelFormat)
  $outPath = "C:\Users\steph\Desktop\5starflow\.claude\screenshots\mobile3-$($c.name).png"
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "Saved: $outPath"
}
$src.Dispose()
Write-Host "Done"
